# TitleVault

TitleVault 为电子单证保管员取证：不是把同一提单反复下载，而是说明某份原件在交接前后由谁控制、依据是什么。服务领取当前可取得的原件，并一并采回背书链与交还声明，形成可复查的资料包；不办理转让或放货。

## 环境与运行

使用 Node.js 22.23.4，依赖版本由 `package-lock.json` 固定。仅使用 Node.js 内置模块，无需外部数据库进程或第三方运行服务。

```sh
npm ci
npm run build
npm test
npm run demo
```

`npm run demo` 在本机启动合作源，用独立临时目录完成真实领取、原文保存、交接核对与领域接收，输出实际结果后清理；不要求外网资料。`npm start` 可单独启动本地来源供交互查看，终端会打印实际回环地址，Ctrl-C 关闭。通过 `PORT` 指定监听端口，省略或设置为 `0` 时自动分配；仅监听回环地址。根路径返回可用资源目录与运行状态。

## 保管员看到的结论

每次领取为每条资料给出一个结论，并附可见权限、控制声明、原件摘要与交接依据：

- `accepted`：交接链与当前受控原件相互支持，资料包**当前齐备**。
- `not-arrived`：背书声明已到，但新平台尚未开放该原件；不拿可下载的旧原件冒充当前控制原件。
- `unverified`：缺关联资料、链未声明交接，或原件入口本次不可取得；不据此认定交还。
- `surrendered`：交还声明或状态已见，原件不列当前。
- `historical`：目录不再列出，保留已合法取得的历史副本供复查。
- `conflict`：分叉声明、缺少中间交接、参与方不衔接、交还与背书并存或身份不一致；交保管员裁定，不按最后抓到的页面定权属。
- `outside` / `error`：不属于所选保管范围，或来源可见但资料无法解释。

每条非完成结论都带 `nextCustodian` 与 `next`，指明下一步向哪个已授权保管来源补什么资料。只有全部资料均为 `accepted` 时 `complete` 才为真。

## 容器

```sh
docker build -t title-vault:local .
docker run --rm --network none title-vault:local
```

镜像构建时准备依赖，容器运行时不联网，演示只使用回环通信。可改用 `docker run --rm --network none title-vault:local npm test` 运行回归。存储通过 `Archive` 传入本机目录，不包含生产账号、真实业务资料或凭据。

## 代码与来源约定

`src/source.mjs` 负责来源目录与原文身份，`src/document.mjs` 解释当前领域记录，`src/relations.mjs` 解释背书、交还与新原件位置，`src/chain.mjs` 核对交接链，`src/access.mjs` 区分访问结果，`src/receiving.mjs` 形成收件结论。`src/archive.mjs` 提供原文保管、收据与逐次观察落库，`src/app.mjs` 连接日常业务，`fixtures/` 与 `src/fixture-source.mjs` 提供可独立复查的本地合作源。详细字段与来源声明见 `docs/source-contract.md`。
