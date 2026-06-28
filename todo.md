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

- [x] **1. 跑正式 seed** ✅ `npm run bt-seed -- --repeats=150 --workers=8`（6283s，本機）→ `bt-history/{classic,pirate,village}.json` 重生（commit `80fc6ba`）。BT #1 = v7:zoner 三圖。
- [x] **2. meta-rank 驗收** ✅ **PASS**：非遞移 RPS 健康——classic zoner-dominant+mid-pool 環、**pirate 真混合 Nash（farmer 81%/reactive 13%/zoner 5%）**、village zoner+trapper 共享頂端；無近 clone（各圖不同 archetype 拿 Nash mass → v6 骨幹沒壓平）。
- [x] **3. 點2 C 定案** ✅ 留著（v5-screen A/B 已證 village +9.4%；seed 場健康）。classic profile 20、pirate 0。
- [x] **4a. commit code + history + memory** ✅ `4ff4330`（code）+ `80fc6ba`（history）；memory 已更新（不再 deferred）。
- [ ] **4b. docs/ai-versions.md**：新增 v7 量尺章節（rebuild 理由、v3→v7 引擎繼承、點1/點2 C、bench 接線、meta-rank 結果）。
- [ ] **5. 合併 `feat/v7-yardstick`**（開 PR 或直接 merge）。
- [ ] **6. PR #33**（bnb-map-tactics doc → main）仍待合併。

## 暫緩 / 待決
- 是否把「v6:hunter 確切進攻調參」加成 v7 第 8 隻當頂錨？目前**不加**（v7:zoner 已提供近冠軍頂端；冠軍照常 bt-rank 上尺）。meta-rank 若顯示頂端解析度不足再加。
- `v5-screen` baseline 快取（`tools/sim-runner/screen-baseline-*.json`）＝拋棄式、gitignored，可不管。
- PR #33（`docs/perf-lag-hunting` → main：三圖戰術 doc + 定速轉角）待合併。
