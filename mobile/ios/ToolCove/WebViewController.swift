import UIKit
import WebKit

/// 主界面：起本地资源服务 → 用 WKWebView 打开它 → 挂上原生桥。
///
/// 这套结构与安卓壳一一对应（AssetsServer / ToolCoveBridge / MainActivity），
/// 连端口列表都一样，就是为了让同一份前端代码在两边的行为一致。
final class WebViewController: UIViewController, WKUIDelegate {

    private var server: AssetServer?
    private var bridge: Bridge?
    private var openPanelCompletion: (([URL]?) -> Void)?

    private let webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        return WKWebView(frame: .zero, configuration: configuration)
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        webView.uiDelegate = self
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

    // ---------- 网页里的选择文件（拍照 / 从相册选） ----------

    /// WKWebView 默认不会响应 <input type="file">，必须实现这个方法。
    /// 这里给一个「拍照 / 从相册选」的选择表，与 App 自己的两个按钮语义一致。
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        openPanelCompletion = completionHandler
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            sheet.addAction(UIAlertAction(title: "拍照", style: .default) { [weak self] _ in
                self?.presentPicker(source: .camera)
            })
        }
        sheet.addAction(UIAlertAction(title: "从相册选", style: .default) { [weak self] _ in
            self?.presentPicker(source: .photoLibrary)
        })
        sheet.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
            self?.finishOpenPanel(urls: nil)
        })
        // iPad 上 actionSheet 必须有锚点，否则直接崩
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = view.bounds
        present(sheet, animated: true)
    }

    private func presentPicker(source: UIImagePickerController.SourceType) {
        let picker = UIImagePickerController()
        picker.sourceType = source
        picker.mediaTypes = ["public.image"]
        picker.delegate = self
        present(picker, animated: true)
    }

    private func finishOpenPanel(urls: [URL]?) {
        let completion = openPanelCompletion
        openPanelCompletion = nil
        completion?(urls)
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

extension WebViewController: UIImagePickerControllerDelegate, UINavigationControllerDelegate {

    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)
        var urls: [URL] = []
        if let url = info[.imageURL] as? URL {
            urls.append(url)
        } else if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
            // 相机拍的原图没有 URL，落一个临时文件给网页（网页只认 File/URL）
            let temp = FileManager.default.temporaryDirectory
                .appendingPathComponent("capture-\(UUID().uuidString).jpg")
            try? data.write(to: temp)
            urls.append(temp)
        }
        finishOpenPanel(urls: urls.isEmpty ? nil : urls)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finishOpenPanel(urls: nil)
    }
}
