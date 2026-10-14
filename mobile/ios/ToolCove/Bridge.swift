import CryptoKit
import Foundation
import Security
import WebKit

/// 原生桥：把 WKWebView 的消息回执，适配成 JS 里 ToolCove.invoke(cmd, args) 的 Promise。
///
/// 与安卓的差别：@JavascriptInterface 是**同步**返回的，而 WKWebView 的消息处理必须异步，
/// 所以这里用 id 配对——JS 调 invoke 时挂起，原生算完后再 evaluateJavaScript 回填
/// window.ToolCove.__resolve(id, json)。前端那层（mobile/app/platform/bridge.js）只认
/// 「invoke 是个函数」，返回 Promise 一样能用，**JS 一行都不用改**。
///
/// 命令名与桌面端/安卓端**完全同名**，形状也照抄（含错误对象 {"__error","__code"}），
/// 这样 src/ 里的仓储、同步、AI 那些代码不需要知道自己在哪个平台上。
final class Bridge: NSObject, WKScriptMessageHandler {

    static let messageName = "ToolCove"

    /// 注入脚本：定义 window.ToolCove（形状与安卓一致，只是 invoke 返回 Promise）。
    static let injectedScript = """
    (function () {
      if (window.ToolCove && typeof window.ToolCove.invoke === 'function') return;
      var pending = {};
      var seq = 0;
      window.ToolCove = {
        invoke: function (cmd, args) {
          return new Promise(function (resolve) {
            var id = ++seq;
            pending[id] = resolve;
            window.webkit.messageHandlers.ToolCove.postMessage({ id: id, cmd: cmd, args: args || {} });
          });
        },
        __resolve: function (id, json) {
          var done = pending[id];
          if (!done) return;
          delete pending[id];
          done(json);
        }
      };
    })();
    """

    private weak var webView: WKWebView?
    private let queue = DispatchQueue(label: "toolcove.bridge")

    init(webView: WKWebView) {
        self.webView = webView
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any],
              let id = payload["id"] as? Int,
              let cmd = payload["cmd"] as? String else { return }
        let args = payload["args"] as? [String: Any] ?? [:]
        // 桥在后台线程干活：URLSession/Keychain 都是阻塞式等待，不能占住主线程。
        queue.async { [weak self] in
            let json = Bridge.dispatch(cmd: cmd, args: args)
            DispatchQueue.main.async {
                guard let webView = self?.webView else { return }
                let literal = Bridge.jsLiteral(json)
                webView.evaluateJavaScript("window.ToolCove.__resolve(\(id), \(literal))", completionHandler: nil)
            }
        }
    }

    // ---------- 命令分发 ----------

    static func dispatch(cmd: String, args: [String: Any]) -> String {
        do {
            switch cmd {
            case "app_version":
                return json(appInfo())
            case "http_request":
                return json(try httpRequest(args))
            case "encrypt_text":
                return json(["cipher": try SecretVault.encrypt(text: args["plain"] as? String ?? "")])
            case "decrypt_text":
                return json(["plain": try SecretVault.decrypt(cipher: args["cipher"] as? String ?? "")])
            case "download_to_device":
                return json(try downloadToDevice(args))
            default:
                return error("手机端尚未实现该命令：\(cmd)", code: "unsupported")
            }
        } catch {
            return self.error(error.localizedDescription, code: "native_error")
        }
    }

    /// 版本信息：形状与安卓 appInfo() 一致，更新流程的 JS 不用改。
    /// canInstall 恒为 false——iOS 没有「下载个 ipa 自己装」这回事（签名由用户侧工具负责）。
    static func appInfo() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? ""
        let build = info["CFBundleVersion"] as? String ?? "0"
        return [
            "versionName": version,
            "versionCode": Int(build) ?? 0,
            "derivedCode": 0,
            "package": Bundle.main.bundleIdentifier ?? "",
            "platform": "ios",
            "canInstall": false,
        ]
    }

    /// 一次 HTTP 请求（绕过 CORS：七牛的管理接口在浏览器里永远过不去，只能走原生）。
    /// 出入参形状与安卓 HttpNative 对齐；headers **两种形状都收**（数组优先，见安卓那次的教训）。
    static func httpRequest(_ args: [String: Any]) throws -> [String: Any] {
        guard let urlText = args["url"] as? String, let url = URL(string: urlText) else {
            throw BridgeError("缺少 url")
        }
        var request = URLRequest(url: url)
        request.httpMethod = (args["method"] as? String ?? "GET").uppercased()
        let timeout = Double(args["timeoutMs"] as? Int ?? 30_000) / 1000
        request.timeoutInterval = timeout > 0 ? timeout : 30
        for (name, value) in headerPairs(args) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if let body = args["body"] as? String, !body.isEmpty,
           request.httpMethod != "GET", request.httpMethod != "HEAD" {
            request.httpBody = Data(body.utf8)
        }

        let started = Date()
        let semaphore = DispatchSemaphore(value: 0)
        var result: [String: Any] = [:]
        var failure: Error?
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error {
                failure = error
                return
            }
            guard let http = response as? HTTPURLResponse else {
                failure = BridgeError("响应不是 HTTP")
                return
            }
            let bytes = data ?? Data()
            var payload: [String: Any] = [
                "status": http.statusCode,
                "statusText": HTTPURLResponse.localizedString(forStatusCode: http.statusCode),
                "headers": http.allHeaderFields.map { ["\($0.key)", "\($0.value)"] },
                "durationMs": Int(Date().timeIntervalSince(started) * 1000),
                "size": bytes.count,
            ]
            // 能当文本就当文本；二进制另给 bodyBase64（与 Rust/安卓的约定一致）
            if let text = String(data: bytes, encoding: .utf8) {
                payload["body"] = text
            } else {
                payload["body"] = ""
                payload["bodyBase64"] = bytes.base64EncodedString()
            }
            result = payload
        }
        task.resume()
        if semaphore.wait(timeout: .now() + timeout + 5) == .timedOut {
            task.cancel()
            throw BridgeError("请求超时")
        }
        if let failure { throw failure }
        return result
    }

    /// 下载到 App 的 Documents（打开 UIFileSharingEnabled 后能在「文件」App 里看到）。
    static func downloadToDevice(_ args: [String: Any]) throws -> [String: Any] {
        guard let urlText = args["url"] as? String, let url = URL(string: urlText) else {
            throw BridgeError("缺少 url")
        }
        guard url.scheme == "https" || url.host == "127.0.0.1" || url.host == "localhost" else {
            throw BridgeError("下载地址不被允许（只接受 https 或本机回环）")
        }
        let rawName = (args["fileName"] as? String) ?? url.lastPathComponent
        let name = safeFileName(rawName)
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        for (header, value) in headerPairs(args) {
            request.setValue(value, forHTTPHeaderField: header)
        }

        let semaphore = DispatchSemaphore(value: 0)
        var location = ""
        var failure: Error?
        let task = URLSession.shared.downloadTask(with: request) { temp, response, error in
            defer { semaphore.signal() }
            if let error {
                failure = error
                return
            }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                failure = BridgeError("下载失败：HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
                return
            }
            guard let temp else {
                failure = BridgeError("下载失败：没有拿到数据")
                return
            }
            do {
                let dir = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                let target = uniqueURL(in: dir, name: name)
                try FileManager.default.moveItem(at: temp, to: target)
                location = "文件 App ▸ ToolCove/\(target.lastPathComponent)"
            } catch {
                failure = error
            }
        }
        task.resume()
        if semaphore.wait(timeout: .now() + 125) == .timedOut {
            task.cancel()
            throw BridgeError("下载超时")
        }
        if let failure { throw failure }
        return ["ok": true, "name": name, "location": location]
    }

    // ---------- 小工具 ----------

    /// headers 两种形状都收：[[名, 值], …] 优先，对象其次（安卓桥同款宽容度）。
    static func headerPairs(_ args: [String: Any]) -> [(String, String)] {
        var pairs: [(String, String)] = []
        if let list = args["headers"] as? [[Any]] {
            for item in list {
                guard item.count >= 1, let name = item[0] as? String else { continue }
                pairs.append((name, item.count > 1 ? "\(item[1])" : ""))
            }
        }
        if let map = args["headers"] as? [String: Any] {
            for (name, value) in map where !pairs.contains(where: { $0.0.caseInsensitiveCompare(name) == .orderedSame }) {
                pairs.append((name, "\(value)"))
            }
        }
        return pairs
    }

    /// 文件名净化：去掉路径成分与控制字符（与安卓 DownloadKit 同一套规则）。
    static func safeFileName(_ name: String) -> String {
        let base = name.split(separator: "/").last.map(String.init) ?? name
        let cleaned = base.unicodeScalars.map { scalar -> Character in
            if scalar.value < 32 || scalar.value == 58 || scalar.value == 92 || scalar.value == 42 ||
                scalar.value == 63 || scalar.value == 34 || scalar.value == 60 || scalar.value == 62 ||
                scalar.value == 124 {
                return "_"
            }
            return Character(scalar)
        }
        let trimmed = String(cleaned).trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return trimmed.isEmpty ? "photo" : String(trimmed.prefix(120))
    }

    static func uniqueURL(in directory: URL, name: String) -> URL {
        let candidate = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: candidate.path) else { return candidate }
        let ext = candidate.pathExtension
        let stem = candidate.deletingPathExtension().lastPathComponent
        for index in 1..<1000 {
            let next = "\(stem) (\(index))\(ext.isEmpty ? "" : ".\(ext)")"
            let url = directory.appendingPathComponent(next)
            if !FileManager.default.fileExists(atPath: url.path) { return url }
        }
        return candidate
    }

    static func json(_ value: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return error("结果无法序列化", code: "native_error")
        }
        return text
    }

    static func error(_ message: String, code: String) -> String {
        // 形状与安卓 Bridge.error 一致：前端 isBridgeUnsupported 靠 __code 判断要不要回退
        let escaped = message.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        return "{\"__error\":\"\(escaped)\",\"__code\":\"\(code)\"}"
    }

    /// 把 JSON 字符串变成能塞进 evaluateJavaScript 的 JS 字面量。
    static func jsLiteral(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [text], options: []),
              let array = String(data: data, encoding: .utf8), array.count >= 2 else {
            return "''"
        }
        return String(array.dropFirst().dropLast())
    }
}

struct BridgeError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}

/// 密钥材料：明文只存在 Keychain（kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly），
/// 加解密用 AES-GCM。与安卓 Keystore（AES/GCM）语义一致：密文自带 nonce 与 tag。
enum SecretVault {

    private static let service = "com.githublcb.toolcove"
    private static let account = "toolcove-secret"

    static func encrypt(text: String) throws -> String {
        let sealed = try AES.GCM.seal(Data(text.utf8), using: try key())
        guard let combined = sealed.combined else { throw BridgeError("加密失败") }
        return combined.base64EncodedString()
    }

    static func decrypt(cipher: String) throws -> String {
        guard let data = Data(base64Encoded: cipher) else { throw BridgeError("密文不是合法 base64") }
        let box = try AES.GCM.SealedBox(combined: data)
        let opened = try AES.GCM.open(box, using: try key())
        return String(decoding: opened, as: UTF8.self)
    }

    private static func key() throws -> SymmetricKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        var existing: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &existing) == errSecSuccess,
           let data = existing as? Data, data.count == 32 {
            return SymmetricKey(data: data)
        }
        let fresh = SymmetricKey(size: .bits256)
        let bytes = fresh.withUnsafeBytes { Data($0) }
        var insert = query
        insert[kSecValueData as String] = bytes
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(insert as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw BridgeError("密钥写入 Keychain 失败：\(status)")
        }
        return fresh
    }
}
