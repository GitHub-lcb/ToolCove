package com.githublcb.toolcove.bridge

import java.io.File
import java.io.FileNotFoundException

/**
 * 网页拍照落点（`<input type="file" capture>` → 系统相机）的原生侧纯逻辑。
 *
 * 场景：照片工具的手机端走浏览器形文件输入，`capture` 提示系统拉相机。WebView 不会替我们
 * 安排照片落到哪，得自己给相机一个 `content://` 输出 URI（EXTRA_OUTPUT），照片只写进本应用
 * 缓存目录——不进系统相册中转，原始字节直接交给网页上传。
 *
 * 拆成纯逻辑是为了能在电脑上测：路径约束一旦松掉（`../` 之类），相机就会被指到任意路径；
 * 而文件名的字符集约束是这条路径不被"手改 URI"击穿的唯一防线。
 * 与 [UpdateKit] 的安装包路径约束同一套手法（canonical 前缀比对）。
 */
object PhotoCaptureKit {

    /** 只读/只写暴露缓存目录的 content:// 提供者身份（与 AndroidManifest 逐字一致）。 */
    const val AUTHORITY = "com.githublcb.toolcove.capture"

    /** 缓存目录下的子目录名：相机只认这里。 */
    const val DIR = "camera"

    /** 允许的文件名形状：本应用生成，毫秒时间戳 + .jpg。手改 URI 塞进来的其它名字一律拒绝。 */
    private val NAME_RE = Regex("^capture-[0-9]{10,20}\\.jpg$")

    /** 拍照临时文件保留时长：超过即清理，缓存目录不无限涨。 */
    const val MAX_AGE_MILLIS: Long = 24 * 60 * 60 * 1000

    fun newCaptureName(stampMillis: Long): String = "capture-$stampMillis.jpg"

    fun isCaptureName(name: String): Boolean = NAME_RE.matches(name)

    /** 相机目录（会创建）。 */
    fun captureDir(cacheDir: File): File = File(cacheDir, DIR).apply { mkdirs() }

    /**
     * 解析到缓存目录内的目标文件。任何越界或名字不合法一律 [FileNotFoundException]——
     * 调用方（Provider）把异常原样交给系统，表现为"打不开"，而不是写到别处。
     */
    @Throws(FileNotFoundException::class)
    fun resolveCaptureFile(cacheDir: File, name: String): File {
        if (!isCaptureName(name)) throw FileNotFoundException("文件名不合法：$name")
        val root = captureDir(cacheDir).canonicalFile
        val file = runCatching { File(root, name).canonicalFile }.getOrNull()
            ?: throw FileNotFoundException("路径不合法")
        if (!file.path.startsWith(root.path + File.separator)) throw FileNotFoundException("越出缓存目录")
        return file
    }

    /** 清理过期的拍照临时文件（上传成功与否都以时间为界，不做跨端清点）。 */
    fun pruneStale(cacheDir: File, now: Long, maxAgeMillis: Long = MAX_AGE_MILLIS) {
        val dir = File(cacheDir, DIR)
        if (!dir.isDirectory) return
        dir.listFiles()?.forEach { file ->
            runCatching {
                if (now - file.lastModified() > maxAgeMillis) file.delete()
            }
        }
    }
}
