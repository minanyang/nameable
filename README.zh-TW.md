<div align="center">

# Nameable

在你的專案會發佈的每個地方查名稱有沒有被用，而且不把 404 當成「可以用」。

[![npm](https://img.shields.io/npm/v/nameable)](https://www.npmjs.com/package/nameable) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-D97757)](https://code.claude.com/docs/en/plugins)

[English](README.md) · **繁體中文**

</div>

Nameable 會在套件 registry、GitHub、AI agent 目錄和網域上查一個名稱，附上每個答案背後的證據，也會說明每個答案有多確定。它可以當 CLI 用，也可以當 AI agent 的 MCP server，還有一個 Claude Code plugin，會另外找有沒有人做過一樣的東西，並建議該留下哪個名字。

## 為什麼需要 Nameable

大部分的名稱檢查工具，只會問每個 registry「這個名字存在嗎」，查不到就當成可以用。但查不到只代表沒有人用了一模一樣的名字，registry 還是可能拒絕它：

| 名稱           | Registry  | 查不到？ | Registry 實際的處理                     |
| -------------- | --------- | -------- | --------------------------------------- |
| `f1ask`        | PyPI      | 是       | 拒絕：和 `flask` 太像                   |
| `first-one`    | npm       | 是       | 拒絕：去掉標點後和 `firstone` 相同      |
| `golang`       | Homebrew  | 是       | 已被佔用：是 `go` 的別名                |
| `rust`         | crates.io | 是       | 拒絕：crates.io 保留的名稱              |
| `gh`           | crates.io | 是       | 拒絕到 2027 年：這個 crate 最近才被刪除 |
| `xn--ls8h.dev` | 網域      | 是       | 無法註冊：它是 emoji 的 punycode        |

Nameable 套用每個 registry 自己的規則（直接取自它們的原始碼），也會檢查這些規則需要的清單：相似名稱、保留名稱、別名和舊名、最近刪除的名稱、已 unpublish 的套件。有規則沒辦法查時，答案會標成「可能可用」並說明原因，而不是直接說「可用」。請求失敗一律是 `unknown`，絕不會當成可用。

## 在終端機使用

需要 Node.js 22 以上。

```sh
npx nameable nameable --tlds com,dev,sh
```

```
Checking "nameable" on 10 channels

  ✗ npm             taken              Find out if a name is free everywhere it matters for your p…
  ✓ PyPI            available
  ✓ crates.io       available
  ✓ Homebrew        available          no homebrew-core formula or cask
  ✓ GitHub user/org probably available suspended, deleted or reserved accounts also look free; con…
  ✓ Smithery        probably available no public servers; a namespace with none, or with only unli…
  ✓ Claude plugins  available          not in the official marketplace
  ✗ .com            taken              registered 1999-02-13, expires 2027-02-13
  ✓ .dev            probably available not registered; premium or reserved names can still be refu…
  ✓ .sh             probably available not registered (whois); premium or reserved names can still…

  npm   https://www.npmjs.com/package/nameable
  .com  https://lookup.icann.org/en/lookup?name=nameable.com

  8 available · 2 taken
```

一次查好幾個名稱時，會用表格比較：

```sh
npx nameable twinsy dupefind fclones --only crates,homebrew,github,domain --tlds com,dev,sh
```

```
                   twinsy    dupefind  fclones
  crates.io        ✓         ✓         ✗
  Homebrew         ✓         ✓         ✗
  GitHub user/org  ✗         ✓*        ✓*
  .com             ✗         ✗         ✓*
  .dev             ✓*        ✓*        ✓*
  .sh              ✓*        ✓*        ✓*
  free             4/6       5/6       4/6
```

| 選項            |                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--only <ids>`  | 要查的渠道：`npm`、`pypi`、`crates`、`homebrew`、`github`、`smithery`、`claude-plugins`、`domain`（`--tlds` 裡的每個 TLD）或 `domain:<tld>` |
| `--tlds <list>` | 要查的網域，任何 TLD 都可以（預設 `com,dev`）。沒有 RDAP 的 TLD，例如 `.io`、`.sh`、`.de`，會改用 whois                                     |
| `--json`        | 輸出 JSON；輸出不是終端機時預設就是 JSON                                                                                                    |
| `--refresh`     | 重新下載 registry 的名稱清單                                                                                                                |
| `--clear-cache` | 刪除快取的名稱清單                                                                                                                          |

有 `GITHUB_TOKEN`、`GH_TOKEN` 或 `gh auth token` 時，GitHub 查詢會使用它，以取得較高的 rate limit。

## 搭配 AI agent 使用

### Claude Code plugin

```
/plugin marketplace add minanyang/claude-plugins
/plugin install nameable@minanyang
```

接著直接請它幫你取名，或執行 `/nameable:check <names>`。這個 skill 會根據你的專案挑出重要的渠道、查詢、找有沒有人已經做過一樣的東西，最後對每個候選名稱給出結論：可以用、修改後可以用（加 scope、換 TLD、換 GitHub owner），或放棄。

### MCP server

`npx -y nameable mcp` 會用 stdio 跑一個 MCP server，查詢方式和 CLI 一樣。它只有一個唯讀工具 `check_names`（參數是 `names`，可選 `channels`、`tlds`、`refresh`），以 structured content 回傳[下方的 JSON](#json)。

| 客戶端      | 設定方式                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `claude mcp add nameable -- npx -y nameable mcp`                                                                                             |
| Codex       | `codex mcp add nameable -- npx -y nameable mcp`                                                                                              |
| Gemini CLI  | 加到 `~/.gemini/settings.json`：`{ "mcpServers": { "nameable": { "command": "npx", "args": ["-y", "nameable", "mcp"] } } }`                  |
| VS Code     | `code --add-mcp '{"name":"nameable","type":"stdio","command":"npx","args":["-y","nameable","mcp"]}'`                                         |
| Cursor      | 加到 `.cursor/mcp.json` 或 `~/.cursor/mcp.json`：`{ "mcpServers": { "nameable": { "command": "npx", "args": ["-y", "nameable", "mcp"] } } }` |

## 答案的意思

| 狀態          | 意思                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| `available`   | 沒有人用，registry 也會接受                                                              |
| `reclaimable` | 以前有人用但已釋出（已 unpublish 的 npm 套件），任何人都可以再拿                         |
| `taken`       | 已經有人用；`url` 會顯示是誰                                                             |
| `unavailable` | 沒有人用一模一樣的名字，但 registry 會拒絕：格式不合、保留名稱、太相似，或刪除後暫時封鎖 |
| `unknown`     | 沒有可信的答案：網路錯誤、rate limit、無法辨識的回應。絕對不要當成可用                   |

`available` 會附上確定程度。**Confirmed** 代表這個 registry 所有能用公開資料查的規則都查過了。**Probable**（表格中的 `*`）代表有規則沒辦法查，`note` 會說是哪一條：GitHub 會隱藏被停權和保留的帳號、npm 的相似名稱規則沒辦法查遍所有拼法、registry 可能拒絕溢價或保留的網域，或名稱清單下載失敗。PyPI 有兩條規則依賴它沒有公開的資料，所以即使是 confirmed 的 PyPI 答案也涵蓋不到：管理員禁止的名稱，以及和被隔離專案相似的名稱。

| 渠道           | 除了「查不到」之外還查了什麼                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm            | npm 的命名規則和 Node.js 內建模組、去掉標點後相同的名稱、已 unpublish 的套件和 unpublish 後的 24 小時封鎖；查不到的 scoped 套件可能是私有的，所以是 probable |
| PyPI           | PEP 508 名稱、標準函式庫名稱、相似名稱（`f1ask` = `flask`）、沒有任何 release 或被隔離的專案                                                                 |
| crates.io      | Cargo 的命名規則、保留名稱、最近刪除的名稱、`-` 和 `_` 視為相同                                                                                              |
| Homebrew       | Formula 命名規則、formula 和 cask 的別名與舊名、homebrew-core 不允許的名稱                                                                                   |
| GitHub         | 使用者和組織；隱藏的帳號讓「可用」只能是 probable                                                                                                            |
| 網域           | 任何 TLD，透過 RDAP 或 whois；國際化網域名稱；registry 無法接受的 label                                                                                      |
| Smithery       | Namespace 命名規則；沒有公開 server 的 namespace 看起來也是空的，所以「可用」只能是 probable                                                                 |
| Claude plugins | Anthropic 官方 marketplace；plugin 命名規則，以及 `claude plugin validate` 保留給 Anthropic 的名稱                                                           |

### 名稱清單

PyPI、Homebrew 和 crates.io 的查詢會比對整個 registry 的清單：PyPI 的所有專案、Homebrew 的所有別名和舊名，以及 crates.io 每日資料庫快照中保留和最近刪除的名稱（用 byte range 讀取，只下載 2 GB 檔案中不到 1 MB）。第一次需要時才會下載，總共約 10 MB，之後每天最多下載一次。清單會壓縮存放（約 8.5 MB），位置在 macOS 的 `~/Library/Caches/nameable`、Linux 的 `$XDG_CACHE_HOME/nameable`、Windows 的 `%LOCALAPPDATA%\nameable\Cache`，或 `NAMEABLE_CACHE_DIR`。

### JSON

```json
{
  "schema": 1,
  "reports": [
    {
      "name": "nameable",
      "results": [
        {
          "channel": "npm",
          "label": "npm",
          "status": "taken",
          "url": "https://www.npmjs.com/package/nameable",
          "note": "..."
        },
        {
          "channel": "domain:dev",
          "label": ".dev",
          "status": "available",
          "certainty": "probable",
          "url": "https://lookup.icann.org/en/lookup?name=nameable.dev",
          "note": "..."
        }
      ]
    }
  ]
}
```

結束碼：`0` 每個名稱在每個渠道都是 available 或 reclaimable · `1` 某處是 taken 或 unavailable · `2` 沒有被佔用的，但有渠道沒查成功 · `64` 用法錯誤。

## 預計加入的渠道

Nameable 目前查詢 npm、PyPI、crates.io、Homebrew、GitHub 使用者和組織、Smithery、Claude Code 官方 plugin marketplace，以及網域。下列每個渠道在列出前都實際測試過：查詢一個名稱時，回應能分辨「已存在」和「不存在」。

| 類別          | 渠道                                                 |
| ------------- | ---------------------------------------------------- |
| AI agent      | MCP Registry、Cursor、Gemini CLI 擴充                |
| 套件 registry | Packagist、RubyGems、pub.dev、NuGet、Docker Hub      |
| 編輯器擴充    | VS Code Marketplace、Open VSX、JetBrains Marketplace |
| 社群帳號      | X、YouTube、TikTok                                   |

不是每個渠道都有官方 API。Nameable 讀取公開網頁或沒有文件的端點時，網站隨時可能改版或擋掉請求：這些渠道的「可用」最多只會是 probable，被擋的請求則是 `unknown`。部分規則不公開的 registry（保留名稱、拼字相近的檢查）也一樣。

以下渠道只會顯示有沒有同名的東西存在，不會判定名稱可用：

| 渠道                              | 原因                                             |
| --------------------------------- | ------------------------------------------------ |
| Apple App Store、Google Play      | App 名稱不是唯一的，尚未上架的 App 也查不到      |
| 商標：USPTO（美國）、TIPO（台灣） | 有相同的商標是需要評估的風險，不是單純的可不可以 |

當 Nameable 沒查的渠道對你的專案很重要時，Claude Code skill 會把它列為「未查」，讓你自己確認。

## 授權

Nameable 以 [MIT License](LICENSE) 授權釋出。

Nameable 這個名稱指的是本專案；請不要用它命名 fork 或衍生作品，但說明某個 fork 是基於 Nameable 是可以的。
