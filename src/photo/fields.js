// 配置字段的描述表：两端（手机/桌面）的配置面板都按它渲染，字段的增删只改这一处。
// 每个字段：labelKey（必）、phKey（占位提示，可选）、type（password/checkbox，缺省 text）、mono。
import { PHOTO_PROVIDERS } from "./config.js";

export const PHOTO_FIELDS = {
  endpoint: { labelKey: "toolbox.photo.fieldEndpoint", phKey: "toolbox.photo.fieldEndpointPh", mono: true },
  region: { labelKey: "toolbox.photo.fieldRegion", phKey: "toolbox.photo.fieldRegionPh", mono: true },
  bucket: { labelKey: "toolbox.photo.fieldBucket", phKey: "toolbox.photo.fieldBucketPh", mono: true },
  accessKey: { labelKey: "toolbox.photo.fieldAccessKey", mono: true },
  secretKey: { labelKey: "toolbox.photo.fieldSecretKey", mono: true, type: "password" },
  sessionToken: { labelKey: "toolbox.photo.fieldSessionToken", mono: true, type: "password" },
  pathStyle: { labelKey: "toolbox.photo.fieldPathStyle", type: "checkbox" },
  prefix: { labelKey: "toolbox.photo.fieldPrefix", mono: true },
  domain: { labelKey: "toolbox.photo.fieldDomain", phKey: "toolbox.photo.fieldDomainPh", mono: true },
  uploadHost: { labelKey: "toolbox.photo.fieldUploadHost", phKey: "toolbox.photo.fieldUploadHostPh", mono: true },
  privateBucket: { labelKey: "toolbox.photo.fieldPrivateBucket", type: "checkbox" },
  username: { labelKey: "toolbox.photo.fieldUsername", mono: true },
  password: { labelKey: "toolbox.photo.fieldPassword", mono: true, type: "password" },
};

/** kebab-case：data-role 用（accessKey → access-key），e2e 选择器跟着稳定。 */
export function fieldKebab(key) {
  return String(key).replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/** 某个 provider 的字段描述列表（顺序 = PHOTO_PROVIDERS 里 fields 的顺序）。 */
export function fieldsOf(providerKey) {
  const provider = PHOTO_PROVIDERS.find((p) => p.key === providerKey) || PHOTO_PROVIDERS[0];
  return provider.fields.map((key) => ({ key, kebab: fieldKebab(key), ...(PHOTO_FIELDS[key] || { labelKey: `toolbox.photo.field${key}` }) }));
}
