# AI Usage — iPhoneへの導入

ライセンス: [MIT](LICENSE)。公開時はこのライセンスが第三者による利用・改変・再配布を許可します。

**まず、元のCodexウィジェットをホーム画面から外してください。スクリプトやKeychainの認証は削除しません。**

Codexの5時間・週間と、OpenCode Goの5時間・週間・月間の**残量**を、中サイズの1枚に表示します。実装とモックによる検証は済んでいます。あなたのアカウントでの接続とiPhone表示は、以下の導入時に確認してください。

## 初回の操作（4ステップ）

1. **元のCodexウィジェットを止める。** ホーム画面の元ウィジェットを長押しして「ウィジェットを削除」を選びます。元スクリプトは保存したまま、通常実行を止めます。同じ認証を使う別のウィジェットがあれば、そちらも止めます。既存の専用CLI認証もPCで通常使用しません。
2. **Scriptableにコードを登録する。** `AI Usage.js` をテキストとして開き、ファイル全体をコピーします。iPhoneのScriptableで「＋」を押し、新しいスクリプトへ貼り付け、名前を **AI Usage** にします。コード内へのAPIキー・トークンの貼付けは不要です。
3. **実行してOpenCode Goのキーを入力する。** Scriptableの実行ボタンを押します。最初の専用入力欄に発行済みAPIキーを入力して「保存」を押します。Codexは既存Keychainを読み取ります。メニューの「取得済みの中サイズプレビュー」で表示を確認します。初回は既に取得が試行されています。
4. **中サイズのウィジェットを追加する。** ホーム画面の空白を長押しし、ウィジェット追加でScriptableの中サイズを選びます。追加したウィジェットを長押しして編集し、Scriptに **AI Usage** を指定します。パラメーター入力は不要です。iOSのバージョンによりボタン名は異なります。

キーを入力せずキャンセルしてもCodexは表示できます。OpenCode Goは「設定が必要」と表示します。ホーム画面からの実行では入力画面は出ません。

## 最初に確認すること

1. **残量を照合する。** 同じ時刻帯のCodex利用画面・既存表示とOpenCode Goの管理画面を確認します。管理画面が「使用率」を示す場合は、`100 − 使用率` がこのウィジェットの残量です。例えば使用率1%は残量99%です。
2. **リセット時刻と表示を確認する。** 日本時間の端末なら日本時間で表示します。明るいテーマと暗いテーマで、全5枠・最終取得日時・状態表示に文字切れや重なりがないか確認します。確認完了までは実機検証済みとして扱いません。
3. **失敗時の表示を確認する。** 正常取得後に通信できない状態でScriptableから実行し、前回値と元の取得日時が残ることを確認します。通信を戻して「最新値を取得してプレビュー」を選びます。
4. **接続できないときは診断を確認する。** メニューの「詳細・エラーを見る」で状態を確認します。修正が必要なら「共有用診断を見る」のテキストを共有してください。キー、トークン、auth.json、スクリプトの秘密入力画面は共有しません。

## 日常の操作

ウィジェットをタップすると、このスクリプトが開きます。アプリ内のメニューは次の5つです。

1. **最新値を取得してプレビュー** — 両サービスを再取得し、中サイズで表示します。429による待機中は再取得を抑制します。
2. **取得済みの中サイズプレビュー** — この実行で取得した値を追加通信なしで確認します。
3. **詳細・エラーを見る** — 最終正常取得・最終試行・各リセットまでの残り時間・安全なエラーコードを表示します。
4. **設定** — OpenCode Goキーの登録・差替え・削除、更新要求の間隔、Codex再認証トークンの登録を行います。
5. **共有用診断を見る** — HTTPステータス、既知フィールドの型、枠の状態だけを表示します。API応答値・任意の未知キー名・認証ヘッダーは含めません。自動送信やクリップボードへのコピーは行いません。

設定でOpenCode Goキーを差し替え・削除すると、そのサービスの古いキャッシュと待機状態も消します。キー削除はiPhone上の保存情報を削除する操作であり、OpenCode側での失効操作ではありません。Codexの保存情報は変更しません。

## 表示の読み方

| 表示 | 意味 |
| --- | --- |
| `99%` / バー | 使用率ではなく、残量99%。小数は内部に保持し、表示だけ四捨五入します |
| `--%` / 取得不可 | 数値が欠落・異常・未知の形式。残量100%の意味ではありません |
| `↻ 23:42` / `↻ 10/12 09:15` | 端末のローカル時刻でのリセット予定。別年は年も表示します |
| リセット不明 | リセット情報が欠落、または単位・形式が未対応 |
| 時刻経過・要更新 | 取得済みリセット日時を過ぎています。残量を自動で100%にしません |
| 取得失敗・前回値 | 前回の正常データです。「取得」の日時は元の正常取得日時のままです |
| 古いデータ | 最後の正常取得から30分以上経過。設定した更新間隔に関係なく判定します |
| 一部取得不可 | 一部枠の数値またはリセットを検証できていません。正常な枠は表示します |
| 設定が必要 / 再認証が必要 | 認証情報が未設定、または拒否されています。前回値がある場合は明示します |
| 権限・契約を確認 | HTTP 403。OpenCode Goの契約・キーの権限などを確認します |
| 更新中 | 別実行のCodex認証更新ロックを検出しました。前回値を使い、後で再実行できます |
| 取得制限 | 429で待機中。「詳細」で次の取得可能時刻を確認できます |
| 保存失敗 | 今回の値は取得済みですが、キャッシュ保存に失敗しました |

残量色は50%超が緑、20%超〜50%がオレンジ、20%以下が赤です。小・大サイズ等は「中サイズで使用してください」と表示し、取得を行いません。

## 更新・同時実行の制約

初期値は15分後の更新要求です。「設定」で5〜1440分の整数に変更できます。`refreshAfterDate` は正確な周期の予約ではなく、実際の更新時刻はiOSが決めます。手動取得やウィジェットのタップ後も、ホーム画面への即時反映は保証されません。[Scriptable公式資料](https://docs.scriptable.app/listwidget/#refreshafterdate)

各リクエストに `timeoutInterval = 10` を設定しています。Scriptableの仕様では**通信が待機状態にある時間**のタイムアウトであり、実行全体の厳密な10秒制限ではありません。Codexの更新・401再試行には複数のリクエストが必要です。iOSが実行を先に終了する可能性は残ります。[Request公式資料](https://docs.scriptable.app/request/#timeoutinterval)

Codex更新時はローカルファイルの60秒ロックを確認・取得し、保存済みトークンを読み直します。失敗時も他の実行が更新した保存値を再確認します。**Scriptableには、このファイル操作による原子的な排他の保証がありません。** 同時取得が完全に防げるとは説明しません。元ウィジェットの停止が必要です。手動更新も連打せず、実行終了を待ってください。異常終了時のロックは60秒で失効します。

## Codexの認証が失効した場合だけ

通常の移行ではこの操作は不要です。既存の `auth.json` は、Scriptableによるトークン更新後に古くなっている可能性があります。古いファイルからトークンを繰り返し入力しません。

1. **元ウィジェットの停止を確認する。** 通常のPC用Codex認証を流用せず、ウィジェット専用の新しいログインを作ります。
2. **WindowsのPowerShellで専用ログインを実行する。** 以下はこの成果物の作業ディレクトリ内に認証ファイルを作る手順です。Codex CLIの導入済み環境で実行し、開いたブラウザーで同じChatGPTアカウントにログインします。`CODEX_HOME` は子プロセスだけに設定され、通常のCodex設定は変更しません。

   ```powershell
   $widgetAuthDirectory = Join-Path $env:TEMP 'ai-usage-widget-auth'
   New-Item -ItemType Directory -Path $widgetAuthDirectory -Force | Out-Null
   $widgetLoginInfo = [System.Diagnostics.ProcessStartInfo]::new()
   $widgetLoginInfo.FileName = $env:ComSpec
   $widgetLoginInfo.Arguments = '/d /c codex -c "cli_auth_credentials_store=''file''" login'
   $widgetLoginInfo.UseShellExecute = $false
   $widgetLoginInfo.EnvironmentVariables['CODEX_HOME'] = $widgetAuthDirectory
   $widgetLoginProcess = [System.Diagnostics.Process]::Start($widgetLoginInfo)
   $widgetLoginProcess.WaitForExit()
   ```

3. **新しいrefresh tokenだけを自分の端末へ移す。** 次のコマンドはトークンを表示せずPCのクリップボードにコピーします。安全な端末間転送で自分のiPhoneへ移し、AI Usageの「設定」→「Codexの再認証トークンを登録」の専用入力欄に入力します。auth.json全体は入力・共有しません。

   ```powershell
   $widgetCredentialFile = Join-Path $widgetAuthDirectory 'auth.json'
   $widgetCredentials = Get-Content -LiteralPath $widgetCredentialFile -Raw | ConvertFrom-Json
   if (-not $widgetCredentials.tokens.refresh_token) { throw 'refresh tokenがありません。ログイン結果を確認してください。' }
   Set-Clipboard -Value $widgetCredentials.tokens.refresh_token
   ```

4. **接続を確認する。** 保存後の取得が正常になったことを確認し、PCとiPhoneのクリップボードからトークンを消します。PCでは `Set-Clipboard -Value ''` を実行できます。この専用認証をCLIで通常使用しません。

ログイン操作はこの実装で未実施です。CLIの変更で手順が合わない場合は、[公式認証資料](https://learn.chatgpt.com/docs/auth)と[元ウィジェットの手順](https://github.com/yoyocircle/codex-usage-widget)を確認してください。APIキーの登録ではChatGPTの利用枠認証を置き換えられません。

## 保存情報と対応API

認証はScriptableのKeychainに保存します。Codexの保存キーは元スクリプトと同じ `codex-usage-widget.access-token`、`codex-usage-widget.refresh-token`、`codex-usage-widget.account-id` です。OpenCode Goは `ai-usage-widget.opencode-go-api-key` です。

キャッシュ・更新間隔・429待機時刻・秘密を含まない更新ロックは、`FileManager.local().libraryDirectory()` 内の `AIUsage` フォルダーに保存します。キャッシュは正規化した利用状況だけであり、API応答全文や認証情報は保存しません。Scriptableのローカル保存に関するバックアップ・保護はiOSの管理に従います。

Codexは期間 `18000` 秒と `604800` 秒で枠を識別します。位置だけでは判定しません。`used_percent` は数値0〜100、`reset_at` はUnix秒、`reset_after_seconds` は取得時刻からの相対秒として扱います。

OpenCode Goの公式ソースの初期対応は `usage.rolling / weekly / monthly`、各枠の `percent` とISO文字列の `resetsAt` です。参照実装で扱われる百分率別名、相対秒、明示的なused/limitの組も対応します。文字列の数値・0〜1を比率と推測する処理・単位不明の数値リセットは受け入れません。未知形式の管理画面スクレイピングやCookie認証へ自動移行しません。

APIは変更される可能性があるため、応答形式を変えて実装する場合はfixture・テストと `VALIDATION.md` の根拠も更新してください。参照元のコミットと未確認項目は `VALIDATION.md` に記載しています。

## 自動テスト（開発者向け）

日常利用にNode.jsは不要です。PCでテストする場合だけ、成果物フォルダーで次を実行します。実アカウントやネット接続を使いません。

```powershell
$env:TZ = 'Asia/Tokyo'
node --test tests/test.cjs
```

テストは配布用ファイルの同じ関数を直接読み込み、fixture・通信モック・Scriptable APIモックで検証します。APIモックの成功は、実機での表示品質や実接続の成功を保証しません。
