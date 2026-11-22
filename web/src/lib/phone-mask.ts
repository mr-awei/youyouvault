/**
 * 未登录时不要把本机授权码里的真实手机号直接摆到界面上。
 * 只保留前 3 / 后 4 位用于核对，其余打码；空值原样返回。
 */
export function maskPhone(value?: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length <= 7) return digits ? `${digits.slice(0, 1)}***` : raw;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}
