// 不把第三方回傳內容、Authorization 或 replyToken 放進錯誤訊息。
export class ServiceError extends Error {
  constructor(code, status = undefined) {
    super(code);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
  }
}

export function safeError(error) {
  return {
    code: error instanceof ServiceError ? error.code : 'INTERNAL_ERROR',
    ...(error instanceof ServiceError && error.status ? { status: error.status } : {}),
  };
}

