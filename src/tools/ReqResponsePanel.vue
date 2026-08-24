<script setup>
// 响应面板（RequestTool 拆出）：只读展示 + 保存/复制/跳 JSON 工具委托给父组件
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";

const { t } = useI18n();

const props = defineProps({
  response: { type: Object, default: null },
  respError: { type: String, default: "" },
  respTab: { type: String, default: "body" },
  respPretty: { type: Boolean, default: true },
  respStatusClass: { type: String, default: "other" },
  respSizeText: { type: String, default: "" },
  respIsJson: { type: Boolean, default: false },
  respIsBinary: { type: Boolean, default: false },
  respKindLabel: { type: String, default: "" },
  respFileName: { type: String, default: "" },
  respLines: { type: Array, default: null },
  respBodyPretty: { type: String, default: "" },
  respLang: { type: String, default: "text" },
  openInJson: { type: Function, default: null },
});
const emit = defineEmits(["update:respTab", "update:respPretty", "save", "copy", "jump-to-json"]);
</script>

<template>
  <div class="resp">
    <div class="resp-head">
      <span class="resp-title">{{ t("toolbox.request.respTitle") }}</span>
      <template v-if="response">
        <span class="status" :class="'s-' + respStatusClass">{{ response.status }} {{ response.statusText }}</span>
        <span class="meta"><Icon name="clock" :size="12" />{{ response.durationMs }}ms</span>
        <span class="meta">{{ respSizeText }}</span>
        <span class="spacer"></span>
        <div class="resp-tabs">
          <button class="rst" :class="{ on: respTab === 'body' }" @click="emit('update:respTab', 'body')">Body</button>
          <button class="rst" :class="{ on: respTab === 'headers' }" @click="emit('update:respTab', 'headers')">Headers<span class="dot">{{ response.headers.length }}</span></button>
        </div>
        <label v-if="respTab === 'body'" class="chk"><input :checked="respPretty" type="checkbox" @change="emit('update:respPretty', $event.target.checked)" />{{ t("toolbox.request.pretty") }}</label>
        <button v-if="respTab === 'body' && respIsJson && openInJson" class="mini" :title="t('toolbox.request.openInJsonTitle')" @click="emit('jump-to-json')"><Icon name="open" :size="13" /></button>
        <button class="mini" :class="{ 'save-binary': respIsBinary }" :title="respIsBinary ? t('toolbox.request.saveStreamTitle') : t('toolbox.request.saveRespTitle')" @click="emit('save')"><Icon name="download" :size="13" /></button>
        <button class="mini" :title="t('toolbox.request.copyBodyTitle')" @click="emit('copy')"><Icon name="copy" :size="13" /></button>
      </template>
    </div>
    <div class="resp-body">
      <p v-if="respError" class="resp-err">{{ respError }}</p>
      <p v-else-if="!response" class="ph">{{ t("toolbox.request.phSend") }}</p>
      <template v-else-if="respTab === 'headers'">
        <table class="rh-table">
          <tr v-for="([k, v], i) in response.headers" :key="i"><td class="rh-k">{{ k }}</td><td class="rh-v">{{ v }}</td></tr>
        </table>
      </template>
      <template v-else>
        <div v-if="respIsBinary" class="bin-hint">
          <Icon name="download" :size="18" class="bin-ico" />
          <div class="bin-info">
            <b>{{ t("toolbox.request.binKindLabel", { kind: respKindLabel }) }}</b>
            <span>{{ t("toolbox.request.binHint", { name: respFileName }) }}</span>
          </div>
          <button class="bin-save" @click="emit('save')"><Icon name="download" :size="13" />{{ t("toolbox.request.saveAsFile") }}</button>
        </div>
        <template v-else>
          <span class="lang-badge" :class="'lb-' + respLang">{{ respLang.toUpperCase() }}</span>
          <div v-if="respLines" class="hl-scroll">
            <div v-for="(line, li) in respLines" :key="li" class="hrow">
              <span class="hnum">{{ li + 1 }}</span>
              <span class="hcode"><span v-for="(t, ti) in line" :key="ti" :class="'tok-' + t.c">{{ t.t }}</span></span>
            </div>
          </div>
          <pre v-else class="output">{{ respBodyPretty }}</pre>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.spacer { flex: 1; }

/* 响应 */
.resp { flex: 1; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); overflow: hidden; }
.resp-head { flex-shrink: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 42px; padding: 6px 12px; border-bottom: 1px solid var(--card-border); background: color-mix(in srgb, var(--text) 2%, transparent); }
.resp-title { font-size: var(--fs-base); font-weight: 600; }
.status { font-size: var(--fs-sm); font-weight: 700; font-family: var(--font-num); }
.s-ok { color: var(--success); }
.s-redirect { color: var(--warn); }
.s-client { color: var(--danger); }
.s-server { color: var(--danger); }
.s-other { color: var(--muted); }
.meta { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-num); }
.resp-tabs { display: flex; gap: 2px; }
.rst { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; font-size: var(--fs-sm); color: var(--muted); background: none; border: none; border-radius: var(--r-sm); cursor: pointer; }
.rst.on { color: var(--accent-deep); background: var(--accent-soft); font-weight: 600; }
.dot { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; font-size: var(--fs-xs); font-weight: 700; color: var(--text-invert); background: var(--accent); border-radius: var(--r-pill); }
.chk { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); color: var(--muted); cursor: pointer; }
.mini { padding: 5px; border: 1px solid var(--card-border); background: var(--card); color: var(--muted); border-radius: var(--r-sm); cursor: pointer; }
.mini:hover { color: var(--primary); border-color: var(--primary); }
.mini.save-binary { color: var(--accent-deep); border-color: var(--accent-border); background: var(--accent-soft); }

/* 文件流（二进制）响应提示卡 */
.bin-hint { display: flex; align-items: flex-start; gap: 10px; margin: 12px; padding: 14px; background: var(--accent-soft); border: 1px solid var(--accent-border); border-radius: var(--r-md); }
.bin-ico { flex-shrink: 0; margin-top: 2px; color: var(--accent); }
.bin-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.bin-info b { font-size: var(--fs-sm); color: var(--accent-deep); }
.bin-info span { font-size: var(--fs-xs); color: var(--muted); line-height: var(--lh-body); word-break: break-all; }
.bin-save { flex-shrink: 0; display: inline-flex; align-items: center; gap: 5px; padding: 7px 14px; font-size: var(--fs-sm); font-weight: 600; color: var(--text-invert); background: var(--accent); border: none; border-radius: var(--r-sm); cursor: pointer; }
.bin-save:hover { filter: brightness(1.08); }

.resp-body { flex: 1; min-height: 0; overflow: auto; position: relative; }
.resp-err { margin: 0; padding: 14px; font-size: var(--fs-sm); color: var(--danger); background: var(--danger-soft); font-family: var(--font-mono); word-break: break-word; }
.ph { margin: 0; padding: 16px; font-size: var(--fs-sm); color: var(--muted); }
.output { margin: 0; padding: 12px; font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.6; color: var(--text); white-space: pre; }
.lang-badge { position: absolute; top: 8px; right: 12px; z-index: 2; padding: 1px 7px; font-size: var(--fs-xs); font-weight: 700; border-radius: var(--r-xs); }
.lb-json { color: var(--primary); background: var(--primary-soft); }
.lb-html, .lb-xml { color: var(--warn); background: var(--warn-tint); }
.lb-text { color: var(--muted); background: color-mix(in srgb, var(--text) 6%, transparent); }

.hl-scroll { padding: 12px 0; font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.6; }
.hrow { display: flex; min-width: max-content; }
.hnum { position: sticky; left: 0; flex-shrink: 0; width: 44px; padding-right: 10px; text-align: right; color: var(--muted); background: var(--card); user-select: none; }
.hcode { white-space: pre; padding-right: 12px; }
.tok-key { color: var(--accent-deep); }
.tok-str { color: var(--success); }
.tok-num { color: var(--primary); }
.tok-bool { color: var(--warn); }
.tok-null { color: var(--muted); font-style: italic; }
.tok-punct { color: var(--muted); }

.rh-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-family: var(--font-mono); }
.rh-table td { padding: 6px 12px; border-bottom: 1px solid color-mix(in srgb, var(--text) 5%, transparent); vertical-align: top; word-break: break-all; }
.rh-k { width: 34%; color: var(--accent-deep); font-weight: 600; }
.rh-v { color: var(--text); }
</style>
