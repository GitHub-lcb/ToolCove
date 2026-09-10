#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::network::decode_system_output;

/// 在本地仓库目录执行 git pull，成功返回命令输出，失败返回错误文本。
///
/// --ff-only：本工具没有冲突解决界面，宁可拉取失败也不生成需人工处理的合并提交。
/// GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never：子进程无终端，避免凭据弹窗挂起调用线程。
#[tauri::command]
pub async fn git_pull(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || pull(&path))
        .await
        .map_err(|e| format!("Git 任务异常：{e}"))?
}

fn pull(path: &str) -> Result<String, String> {
    let dir = std::path::Path::new(path.trim());
    if !dir.is_dir() {
        return Err(format!("目录不存在：{path}"));
    }
    let mut command = std::process::Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .args(["pull", "--ff-only"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|e| format!("无法启动 git（请确认已安装并加入 PATH）：{e}"))?;
    let stdout = decode_system_output(&output.stdout);
    let stderr = decode_system_output(&output.stderr);
    let text = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (false, false) => format!("{}\n{}", stdout.trim_end(), stderr.trim_end()),
        (false, true) => stdout.trim_end().to_string(),
        (true, false) => stderr.trim_end().to_string(),
        (true, true) => String::new(),
    };
    if output.status.success() {
        if text.is_empty() {
            Ok("已是最新，无需拉取".into())
        } else {
            Ok(text)
        }
    } else if text.is_empty() {
        Err(format!("git pull 失败（退出码 {:?}）", output.status.code()))
    } else {
        Err(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 路径不存在时应给出明确错误，而不是启动 git 进程
    #[test]
    fn pull_rejects_missing_directory() {
        let missing = std::env::temp_dir().join("git-pull-not-exists-xyz");
        let err = pull(missing.to_str().unwrap()).unwrap_err();
        assert!(err.contains("目录不存在"), "实际错误：{err}");
    }

    /// 空路径同样拒绝
    #[test]
    fn pull_rejects_empty_path() {
        let err = pull("   ").unwrap_err();
        assert!(err.contains("目录不存在"), "实际错误：{err}");
    }
}
