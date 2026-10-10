# 初めて使う人の設定ガイド

**Codex用のウィジェットを一度も作ったことがなくても、この手順で始められます。** 別のウィジェットや旧スクリプトの導入は不要です。

Codexの認証は初回だけPCで作成します。OpenCode Goは契約したアカウントのAPIキーをiPhoneで入力します。初期設定・再認証以外の残量確認にはPCは不要です。

## 最初に用意するもの

1. iPhoneと[Scriptable](https://scriptable.app/)。
2. Codexの残量を確認したいChatGPTアカウント。アカウントやプランで利用枠が提供されている必要があります。
3. 初回のCodex認証を作るWindows PCまたはMac。PCがない場合はCodexの新規設定をこの手順では行えません。OpenCode Goだけを先に設定することはできます。
4. OpenCode Goの契約と、その契約に対応するAPIキー。[OpenCode Go公式ガイド](https://opencode.ai/docs/go/)から管理画面を開き、契約・キー発行を行います。

ChatGPTのパスワードやOpenAI PlatformのAPIキーを、このウィジェットへ入力する必要はありません。Codexの専用ログインから発行される**refresh token**を使います。[公式の認証資料](https://learn.chatgpt.com/docs/auth)

## Windows：Codexを初めて設定する（5ステップ）

1. **Codex CLIを導入する。** スタートメニューからPowerShellを開き、以下の公式インストールコマンドを実行します。導入済みなら省略します。完了後はPowerShellを閉じて開き直し、`codex --version` で導入を確認します。[公式CLI導入手順](https://learn.chatgpt.com/docs/codex/cli)

   ```powershell
   powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
   ```

2. **このリポジトリをZIPでダウンロードする。** [リポジトリ](https://github.com/norei3510/ai-usage-widget)の「Code」→「Download ZIP」を選び、ZIPを展開します。展開フォルダーにある `setup` フォルダーを開きます。エクスプローラーのアドレス欄に `powershell` と入力してEnterを押すと、その場所でPowerShellが開きます。
3. **専用ログインを作る。** 下のコマンドを実行し、開いたブラウザーで残量を見たいChatGPTアカウントへログインします。通常のCodexの保存先とは別の一時フォルダーを使います。トークンは画面に表示されず、PCのクリップボードへコピーされます。Enterを求める画面は、iPhoneへの入力が終わるまでそのままにします。

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\New-CodexWidgetLogin.ps1
   ```

4. **iPhoneへ移して入力する。** 自分の端末間の安全な転送方法でrefresh tokenをiPhoneに移します。WindowsとiPhoneで自動のクリップボード共有は保証されません。AI Usageを実行し、「Codexを設定」→「用意したトークンを入力」の専用欄に貼り付けて保存します。すでに初回画面を閉じている場合は、「設定」→「Codex認証を登録・差替え」から入力できます。`auth.json` 全体は貼り付けません。
5. **表示を確認してクリップボードを消す。** 「この状態で続ける」を選び、Codexの残量が表示されることを確認します。PCのPowerShellへ戻ってEnterを押すと、PCのクリップボードが空になります。iPhone側も無害な文字列をコピーして上書きします。専用認証ファイルはPCの一時フォルダーに残るため、共有しません。この専用ログインをPCのCLIで通常使用しないでください。

この補助スクリプトは自動でCLIを導入せず、通常のCodex用設定も変更しません。実アカウントでのログイン動作は、この配布物の検証時点では未実施です。組織が認証の保存先を制限している場合は、管理者の方針に従ってください。

## Mac：Codexを初めて設定する（4ステップ）

Macでの以下の実行手順は実機未検証です。専用ログインとファイル保存の指定は[OpenAI公式資料](https://learn.chatgpt.com/docs/auth)に基づきます。

1. **ターミナルでCodex CLIを導入する。** 導入済みなら `codex --version` で確認し、インストールを省略します。[公式CLI導入手順](https://learn.chatgpt.com/docs/codex/cli)

   ```bash
   curl -fsSL https://chatgpt.com/codex/install.sh | sh
   ```

2. **新しい専用ログインを作る。** 同じターミナルで以下を実行し、ブラウザーでChatGPTアカウントにログインします。`CODEX_HOME` はこのコマンドの子プロセスにだけ指定します。通常のログインは流用しません。

   ```bash
   widgetAuthDirectory="$(mktemp -d "${TMPDIR:-/tmp}/ai-usage-widget-auth.XXXXXX")"
   env CODEX_HOME="$widgetAuthDirectory" codex -c 'cli_auth_credentials_store="file"' login
   ```

3. **refresh tokenをコピーしてiPhoneへ入力する。** ログイン成功後に以下を実行します。エラーが出たら先にログイン結果を確認してください。Macの標準 `plutil` でJSONの指定フィールドを取り出し、画面に出さずクリップボードへコピーします。自分のiPhoneへ移し、AI Usageの「Codexを設定」→「用意したトークンを入力」に貼り付けます。

   ```bash
   plutil -extract tokens.refresh_token raw -o - "$widgetAuthDirectory/auth.json" | pbcopy
   ```

4. **Codexの残量を確認する。** AI Usageで「この状態で続ける」を選びます。入力後は以下でMacのクリップボードを空にし、iPhone側も上書きします。この専用ログインをCLIで通常使用しません。

   ```bash
   printf '' | pbcopy
   ```

## OpenCode Goを初めて設定する

1. [OpenCode Go公式ガイド](https://opencode.ai/docs/go/)から管理画面へ移り、Goの契約とAPIキーを用意します。キーは契約のあるアカウント・ワークスペースで発行します。
2. iPhoneのAI Usageを実行し、「OpenCode Goを設定」を選びます。APIキーだけを専用入力欄に入力し、「保存」を押します。
3. 「この状態で続ける」を選びます。両方の認証が保存済みになれば、そのまま取得へ進みます。5時間・週間・月間の残量を管理画面と照合します。

後から登録する場合は「設定」→「OpenCode Goキーを登録・差替え」を使います。Codexの設定がまだでも、OpenCode Goだけで表示を始められます。

## すでにCodexウィジェットを使っている人

1. 元のウィジェットをホーム画面から外し、そのスクリプトの通常実行を止めます。スクリプトやKeychainは削除する必要がありません。
2. AI Usageは従来の3つのKeychainキーを引き継ぎます。Codexが「保存済み」になっていれば、そのまま取得を試せます。トークンは入力し直しません。
3. 「再認証が必要」と出たときだけ、上のWindowsまたはMacの手順で新しい専用ログインを作り、「設定」→「Codex認証を登録・差替え」から入力します。

「保存済み」は保存情報の存在を示します。API接続の成功ではありません。通信後の状態と残量で確認してください。

## 困ったとき

| 表示・状態 | 次の操作 |
| --- | --- |
| Codex CLIが見つからない | 導入後にPowerShellまたはターミナルを開き直し、`codex --version` を確認 |
| Codexの設定が必要 | 専用ログインの作成とrefresh tokenの入力を完了 |
| Codexの再認証が必要 | 古いauth.jsonの再利用を止め、新しい専用ログインを作成 |
| 権限・契約を確認 | Goの契約とキーの発行元、Codexアカウントの権限を確認 |
| 取得失敗・取得不可 | AI Usageの「詳細・エラーを見る」。必要なら「共有用診断を見る」のテキストだけを共有 |

キー・トークン・パスワード・auth.jsonの内容は、GitHubのIssueやチャットへ投稿しません。初回設定をキャンセルしても、保存済み認証は消えません。
