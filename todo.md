# TODO — v7 量尺（Bradley-Terry yardstick）收尾

狀態：**程式碼已完成、全綠（client tsc / sim-runner tsc / lint / determinism 17/17）、尚未 commit**。
seed 先前被喊停以加入點1/點2；現已加入並通過 v5-screen 首篩，等跑正式 seed 驗收。

## 已完成（code，未 commit）
- `client/src/ai/v7/`：複製 v6 引擎、`AI_VERSION=7`、roster = v3 非遞移 7 隻（hunter/farmer/zoner/runner/trapper/reactive + noise）。註冊進 `ai/index.ts`。
- champion 仍 v6（修掉 LATEST_AI_VERSION 誤標 bot 名：`main.ts` 改用 championFor）。
- bench：`MapKind`/`MAPS` 解除寫死、加 **village**；量尺池 v3→v7（`YARDSTICK_VERSION` + `isYardstickPoolId`）；`v3-bench` 釘回原本兩圖。
- **點1**（聯通前不停發育）：孤立時 `isolatedFloor` 不再隨 urgency 衰減（`BotController.ts`）。永久。
- **點2 C**（縮圈搶中心）：新 per-map 旋鈕 `shrinkCenterPriorityWeight`。A/B 後設 classic profile（classic+village）=**20**、pirate=**0**（pirate 實測 C 變差）。

## 待辦

- [ ] **1. 跑正式 seed**（背景，~2.5h；mc 遠端目前不可達 → 本機 8 workers）
      ```
      cd tools/sim-runner
      npm run bt-seed -- --repeats=150 --workers=8
      ```
      → 重新產生 `bt-history/{classic,pirate,village}.json`（v7 round-robin，fresh）。

- [ ] **2. meta-rank 驗收**（純讀現成 history、秒級、不對打）
      ```
      cd tools/sim-runner
      npm run meta-rank          # 三圖；看 α-Rank / Nash / BT 並列 + clone-check
      ```
      驗收三點：
      - **RPS 環還在**（α-Rank/Nash 顯示非遞移、不塌成單一純量）。
      - **無近 clone**（Nash 對近複製品自動降權；確認 roster 沒被 v6 防守骨幹壓得太像）。
      - **頂端解析度**（v7:zoner 應接近冠軍級；冠軍 v6:hunter 之後上尺會浮在池略上方）。

- [ ] **3. 依結果定案點2 C**：若 village 的 C 在 150-rep 沒撐住 → `shrinkCenterPriorityWeight` 改回 0（一行，classic profile）。

- [ ] **4. commit**：v7 資料夾 + bench 改動 + 重生的 bt-history + 更新 `docs/ai-versions.md`（新增 v7 量尺章節：rebuild 理由、與 v3 差異、點1/點2、bench 接線）。更新 memory `choccus-bt-yardstick-stale-v7-plan`（已不再 deferred）。

## 暫緩 / 待決
- 是否把「v6:hunter 確切進攻調參」加成 v7 第 8 隻當頂錨？目前**不加**（v7:zoner 已提供近冠軍頂端；冠軍照常 bt-rank 上尺）。meta-rank 若顯示頂端解析度不足再加。
- `v5-screen` baseline 快取（`tools/sim-runner/screen-baseline-*.json`）＝拋棄式、gitignored，可不管。
- PR #33（`docs/perf-lag-hunting` → main：三圖戰術 doc + 定速轉角）待合併。
