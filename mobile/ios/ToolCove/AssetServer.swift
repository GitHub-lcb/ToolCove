import Foundation
import Network

/// 本地静态资源服务：把安装包里的 www/ 挂在 http://127.0.0.1:<端口>/。
///
/// 为什么不用 file:// 或自定义 scheme（这是整个壳最要紧的一个决定）：
/// crypto.subtle 只在**安全上下文**里可用，而 file:// 是 opaque origin、自定义 scheme 也不算
/// 安全上下文——七牛的 HMAC 签名、加密工具箱、WASM 会当场全废（安卓侧踩过，记录在
/// mobile/vite.mobile.config.js 里）。回环 http 被 WebView 视为「潜在可信来源」，拿到安全上下文。
///
/// **端口固定**同样要紧：origin 一变，IndexedDB / localStorage 就等于每次全丢
/// （安卓 1.3.1 的真实事故：随机端口让用户以为数据被清了）。这里与安卓用同一组端口。
final class AssetServer {

    /// 与安卓 AssetsServer.PREFERRED_PORTS 保持一致。
    static let preferredPorts: [UInt16] = [49731, 49732, 49733, 49734]

    private let root: URL
    private let queue = DispatchQueue(label: "toolcove.assets")
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    /// 起服务并返回真实端口：先试固定端口，全被占再退回系统分配（不因为端口冲突就打不开 App）。
    @discardableResult
    func start() throws -> UInt16 {
        for candidate in Self.preferredPorts {
            if let bound = try? startListener(preferred: candidate) {
                port = bound
                return bound
            }
        }
        port = try startListener(preferred: nil)
        return port
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func startListener(preferred: UInt16?) throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        let endpointPort = preferred.flatMap { NWEndpoint.Port(rawValue: $0) } ?? .any
        // 只绑回环：不对外暴露，也不需要「本地网络」权限（那是局域网才要的）
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: endpointPort)
        let listener = try NWListener(using: parameters)

        let ready = DispatchSemaphore(value: 0)
        var bound: UInt16 = 0
        var failure: Error?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                bound = listener.port?.rawValue ?? 0
                ready.signal()
            case .failed(let error):
                failure = error
                ready.signal()
            case .cancelled:
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
        if ready.wait(timeout: .now() + 3) == .timedOut {
            listener.cancel()
            throw AssetServerError.timeout
        }
        if let failure {
            listener.cancel()
            throw failure
        }
        guard bound != 0 else {
            listener.cancel()
            throw AssetServerError.unavailable
        }
        self.listener = listener
        return bound
    }

    // ---------- 极简 HTTP/1.1 ----------

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        read(connection, buffer: Data())
    }

    /// 只读到请求头结束（本服务只处理 GET/HEAD，且请求没有体）。
    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 32 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else {
                connection.cancel()
                return
            }
            var buffer = buffer
            if let data, !data.isEmpty { buffer.append(data) }
            if let headEnd = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<headEnd.lowerBound], as: UTF8.self)
                self.respond(connection, head: head)
                return
            }
            if error != nil || isComplete || buffer.count > 32 * 1024 {
                connection.cancel()
                return
            }
            self.read(connection, buffer: buffer)
        }
    }

    private func respond(_ connection: NWConnection, head: String) {
        let requestLine = head.split(separator: "\r\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? ""
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            send(connection, status: 400, reason: "Bad Request", body: Data("400".utf8), contentType: "text/plain")
            return
        }
        let method = String(parts[0]).uppercased()
        guard method == "GET" || method == "HEAD" else {
            send(connection, status: 405, reason: "Method Not Allowed", body: Data("405".utf8), contentType: "text/plain")
            return
        }
        var path = String(parts[1])
        if let query = path.firstIndex(of: "?") { path = String(path[..<query]) }
        if let hash = path.firstIndex(of: "#") { path = String(path[..<hash]) }
        path = path.removingPercentEncoding ?? path

        let fileURL = resolve(path: path)
        guard let body = try? Data(contentsOf: fileURL) else {
            send(connection, status: 404, reason: "Not Found", body: Data("404".utf8), contentType: "text/plain")
            return
        }
        let payload = method == "HEAD" ? Data() : body
        send(connection, status: 200, reason: "OK", body: payload, contentType: Self.mimeType(for: fileURL))
    }

    /// 把请求路径解析到安装包内的文件；目录取 index.html，找不到的一律回 index.html（前端路由兜底）。
    /// 关键是**必须校验仍在 root 内**：..%2f 这类路径不能让它读到沙箱里的其它文件。
    private func resolve(path: String) -> URL {
        let index = root.appendingPathComponent("index.html")
        let trimmed = path.drop { $0 == "/" }
        var candidate = root.appendingPathComponent(String(trimmed)).standardizedFileURL
        guard candidate.path == root.path || candidate.path.hasPrefix(root.path + "/") else { return index }
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory), isDirectory {
            candidate.appendPathComponent("index.html")
        }
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        return index
    }

    private func send(_ connection: NWConnection, status: Int, reason: String, body: Data, contentType: String) {
        let cache = contentType.contains("text/html") ? "no-store" : "public, max-age=31536000"
        var header = "HTTP/1.1 \(status) \(reason)\r\n"
        header += "Content-Type: \(contentType)\r\n"
        header += "Content-Length: \(body.count)\r\n"
        header += "Cache-Control: \(cache)\r\n"
        header += "Connection: close\r\n\r\n"
        var payload = Data(header.utf8)
        payload.append(body)
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}

enum AssetServerError: LocalizedError {
    case unavailable
    case timeout

    var errorDescription: String? {
        switch self {
        case .unavailable: return "本地资源服务没能绑定端口"
        case .timeout: return "本地资源服务启动超时"
        }
    }
}
