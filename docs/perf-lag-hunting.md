# 前端效能 / 卡頓診斷流程

抓瀏覽器 lag/jank 的階梯流程。**先量測再修**——別用猜的。

渲染層是 **DOM/CSS**（非 Pixi）；重的 box-shadow / gradient 住在 `client/src/render/candyArt.ts`、tile 與 entity 的 stacking 在 `client/src/render/Renderer.ts`。工具走 chrome-devtools MCP。

## 階梯（依序跑）

1. **DevTools trace** — 開頁面 → `performance_start_trace`（`reload:false, autoStop:false`）→ 請使用者觸發卡頓 → `performance_stop_trace` → 讀 INP + `performance_analyze_insight INPBreakdown`。拆成 input delay / **processing**（event-handler JS）/ **presentation**（畫下一幀的時間）。processing-bound → 慢的 JS handler；presentation-bound 且 JS 快 → **browser paint/composite**。

2. **rAF 內 frame probe** — 在 rAF 迴圈（`main.ts` `frame()`）log 原始 inter-frame gap（`now-last`，clamp 前），對 gap >50ms 拆成「我的 JS」（`performance.now()` 包住 tick+render）vs「browser/other（gap − JS）」。標 `// [lag-probe]`、查完移除。實測過 sim/AI+render JS 都 0–1ms 而 gap 50–130ms → 成本 100% 在 browser 端。

3. **LoAF** — 用 `evaluate_script` 掛 `PerformanceObserver({type:'long-animation-frame'})`；每筆算 `renderMs = (start+duration)−renderStart` 與 `styleAndLayoutMs`。長幀的 renderMs/styleLayoutMs ≈ 0 且 0 scripts → 時間花在 **compositor/GPU raster+present**（不在 main thread），不是 style/layout。

4. **排除軟體渲染** — `evaluate_script` 開 WebGL ctx 讀 `UNMASKED_RENDERER_WEBGL`（真機應是 "ANGLE Metal … Apple M3" 之類的真 GPU）→ 確認 jank 是真的、非 headless-Chrome 假象。

5. **Live CSS A/B（最有用）** — 用 `evaluate_script` inject 一個 `<style>`，量有/無它時的 rAF interval avg/max/fps——免改檔、即時歸因。先粗（`*{box-shadow:none!important;filter:none!important;animation:none!important}`）再逐 property 排兇手。**注意**：jank 是間歇的（隨畫面上炸彈/爆炸數放大），單次取樣很吵 → 優先用會聚合的 frame probe，別只靠一場遊玩的直覺。

## 已知兇手（兩次實戰）

- **Round 1**：`box-shadow` + 無限 `transform` keyframe 動畫（`cc-bomb`/`cc-flame`）→ GPU 每幀重新光柵化帶陰影的元素。修法＝拿掉那兩個無限動畫（靜態美術全留）。`MAX_TICKS_PER_FRAME` catch-up cap 是對的但**沒**修到這個（瓶頸從來不是 JS）。

- **Round 2（v6 積極 bot 下復發）**：195 個 inset-box-shadow 的棋盤 tile 每幀重光柵化。`Renderer.ts` 把 tile + entity 放**同一個 stacking context**（per-row z-index 做 2.5D 遮擋），任何移動的 entity 弄髒單一 layer 就在其 dirty-rect 重光柵那些帶陰影的 tile（隨爆炸數放大 → v6 放更多彈 → lag 回來）。修法＝把每個靜態 tile 提成自己的 GPU texture：tile node 上 `transform:translateZ(0)`（`Renderer.ts:283`）。A/B 證實 49fps/13-jank → 60fps/0-jank，保留所有陰影 + z-order。

> 陰影現已 GPU-cached，下次回歸很可能是**新的每幀變動的帶陰影元素**（會動且有 box-shadow 的 entity 或 item），不是 tile。

## 教訓

第一直覺常錯：以為是 bot 的 depth-4 forward search 卡 main thread → 實測 AI 只 0–1ms。**信 profile 不信假設**。net-unification（共用 LockstepEngine）也是 red herring——self-host 房 + bot 每個 slot 都在本機算、本機 buffer 輸入，不等 relay，input latency 同 solo loopback。這裡的 lag 永遠是 render/paint。

下個「很卡」回報，照 1→5 走、先把成本歸因（JS vs browser paint vs compositor）再動 code。DOM-render 的 paint 成本，先抓 step 5 的 live CSS A/B——最快釘到兇手 property。
