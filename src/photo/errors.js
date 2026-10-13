// 带错误码的存储错误：上游（视图 / 队列）按 code 决定提示文案，message 原样透出便于排查。
export class PhotoError extends Error {
  constructor(code, message) {
    super(message ? `${code}: ${message}` : code);
    this.name = "PhotoError";
    this.code = code;
    this.detail = message || "";
  }
}
