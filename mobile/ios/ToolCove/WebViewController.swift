import UIKit
import WebKit

/// 主界面：起本地资源服务 → 用 WKWebView 打开它 → 挂上原生桥。
///
/// 这套结构与安卓壳一一对应（AssetsServer / ToolCoveBridge / MainActivity），
/// 连端口列表都一样，就是为了让同一份前端代码在两边的行为一致。
///
/// 关于 <input type="file">（拍照/相册选图）：iOS 的 WKWebView **自带**系统选择器，
/// 不需要实现 WKUIDelegate——那个 runOpenPanelWith 回调是 iOS 18.4 才有的 API，
/// 我们部署目标 15.0，自己实现反而要写一堆版本分支（第一版就为此编译失败过一次）。
final class WebViewController: UIViewController {

    private var server: AssetServer?
    private var bridge: Bridge?

    private let webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        return WKWebView(frame: .zero, configuration: configuration)
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        guard let root = Bundle.main.url(forResource: "www", withExtension: nil) else {
            showFatal("安装包里没有网页资源（www/），这个包不完整")
            return
        }
        do {
            let server = AssetServer(root: root)
            let port = try server.start()
            self.server = server

            let bridge = Bridge(webView: webView)
            self.bridge = bridge
            webView.configuration.userContentController.add(bridge, name: Bridge.messageName)
            webView.configuration.userContentController.addUserScript(
                WKUserScript(source: Bridge.injectedScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )

            guard let url = URL(string: "http://127.0.0.1:\(port)/") else {
                showFatal("本地地址拼装失败")
                return
            }
            webView.load(URLRequest(url: url))
        } catch {
            showFatal("本地资源服务启动失败：\(error.localizedDescription)")
        }
    }

    deinit {
        server?.stop()
    }

    private func showFatal(_ message: String) {
        let label = UILabel()
        label.text = message
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .secondaryLabel
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
    }
}
