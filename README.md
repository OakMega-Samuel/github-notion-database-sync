# github-notion-database-sync

把這個 repo 的 `specs/` 資料夾裡的產品規格書（`.md`），單向自動同步到 Notion 的一個 database。
方向永遠是 **GitHub → Notion**：在 repo 新增/修改/刪除規格書，Notion 會自動反映；請不要在 Notion
上直接編輯內容，改動會在下一次同步時被覆蓋。

Notion database：[產品規格書同步](https://app.notion.com/p/a5c91f7532c845e5991bc6bdadd4f429)

## 運作方式

- 每次 push 到 `main` 且 `specs/**` 有變動時，GitHub Actions 會執行 `scripts/sync.js`。
- 腳本會掃描目前 `specs/` 底下所有 `.md`，用檔案的相對路徑（例如 `specs/example.md`）當唯一識別碼：
  - Notion 沒有對應列 → 新增一列
  - Notion 已有對應列 → 更新標題／內容／GitHub 連結／同步時間
  - Notion 有列但檔案已經找不到（被刪除或改名）→ 該列標記為 `Status: Archived`，並清空內容
    （不會真的刪除該列，避免不可逆的資料遺失）
- Markdown 內容會完整轉換成 Notion 的 blocks（標題、清單、code block、表格等）。
- 每一列都會有一個 `GitHub URL` 欄位，連回該規格書在 GitHub 上目前分支的原始檔案。

## 新增規格書

在 `specs/` 底下新增一個 `.md` 檔案即可，建議用第一行 `# 標題` 當這份規格書的標題（沒有的話會
用檔名代替）。Push 到 `main` 後，Actions 就會自動同步。

## 一次性設定（Repo 管理者需要做的事）

### 1. 建立 Notion Integration 並分享 database

1. 到 https://www.notion.so/profile/integrations 建立一個新的 internal integration，
   複製它的 secret token。
2. 打開上面連結的「產品規格書同步」database，右上角 `···` → `Connections` → `Add connections`，
   把剛建立的 integration 加進去（要有能編輯此 database 的權限）。

### 2. 在 GitHub repo 設定 Secrets

到這個 repo 的 `Settings → Secrets and variables → Actions`，新增：

| Secret 名稱 | 值 |
|---|---|
| `NOTION_API_KEY` | 上一步拿到的 integration secret token |
| `NOTION_DATABASE_ID` | `a5c91f7532c845e5991bc6bdadd4f429` |

設定好後，之後對 `specs/**` 的每次 push 都會自動觸發同步。也可以到 Actions 分頁手動
`Run workflow`（`workflow_dispatch`）觸發一次全量同步。

## 本機測試

```bash
npm install
NOTION_API_KEY=xxx NOTION_DATABASE_ID=a5c91f7532c845e5991bc6bdadd4f429 npm run sync
```
