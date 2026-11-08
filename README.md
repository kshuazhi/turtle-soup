# 海龟汤 · 情境推理

一个黑白极简风格的海龟汤（情境推理）网站，自带后端，支持**单机推理**和**多人联机房间**，可跑在电脑和手机浏览器上，也能直接部署到云服务器。

- 汤面 / 汤底分离：只看汤面，自己推理，猜对才揭开汤底
- 渐进提示：卡住了可以逐条要提示
- 联机房间（主持人模式）：**谁创房谁是主持人**，主持人自己写汤面和汤底；玩家提问，主持人答「是 / 否 / 无关」；有人猜中或主持人公布汤底后，主持人决定是否把主持人交给别人再开下一轮
- 联机有两种入口：**自己出题**（主持人现场写）和**题库开桌**（从题库挑一道，适合马上开局）
- 实时同步：基于 SSE（Server-Sent Events），断线自动重连
- 黑白双主题、页面渐入渐出、全站仿宋字体
- 无前端构建步骤，也没有前端框架，直接 `node server.js` 就能跑

## 界面

| 页面 | 说明 |
| --- | --- |
| `/community` | 玩家投稿：只收录通过 PR 合并的海龟汤，独立搜索与标签 |
| `/` | 题库：搜索、标签、排序、分页、随机 |
| `/play/:id` | 阅读汤面、要提示、提交推理、揭晓汤底 |
| `/rooms` | 联机第一屏：创建房间（自己出题 / 题库开桌）、加入房间、改名、进行中的房间 |
| `/room/:code` | 房间内：准备区（全员准备 + 主持人开始游戏）、汤面、玩家列表、提问与回答、改名 |
| `/new` | 投稿教程：通过 GitHub Pull Request 提交海龟汤 |
| `/about` | 玩法说明 |

## 快速开始

需要 Node.js 18 及以上。

```bash
npm install
npm start
```

默认监听 `0.0.0.0:3300`，浏览器打开：

- 本机：<http://127.0.0.1:3300>
- 局域网内手机：`http://<电脑局域网 IP>:3300`

改端口：`PORT=8080 npm start`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3300` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据文件目录（`db.json`） |
| `ADMIN_KEY` | 空 | 设置后可用 `x-admin-key` 请求头调用删除接口；不设置则删除功能关闭 |

可以直接复制 `.env.example` 参考填写，或用进程管理器的环境变量注入。

## 数据存储

- 题库、点赞、浏览量写入 `data/db.json`，进程退出时会落盘。
- 首次启动会自动写入内置题库（10 道经典汤）。
- 进行中的房间会定期快照到同一文件的 `roomSnapshots` 字段；服务重启后，房主和玩家用原浏览器重新打开房间链接即可续上（同屏身份保存在 `sessionStorage`）。
- 想清空数据：停服务后删除 `data/db.json` 即可。

### 服务器更新后保留翻煮次数 / 喜欢

`views` / `likes` 都存在 `data/db.json`，**更新代码本身不会动它**；会丢只有一种情况：部署时把 `data/` 一起清掉了（容器重建、重新 clone 覆盖、Docker 构建覆盖等）。按部署方式处理：

| 部署方式 | 做法 |
| --- | --- |
| Railway / 容器平台 | 挂一个 Volume 到 `/data`，设置 `DATA_DIR=/data`（见 Railway 章节）；重新部署时 Volume 不变 |
| 云服务器（直接跑） | 把数据放到代码目录之外：`DATA_DIR=/var/lib/turtle-soup`；`git pull` / `rsync` 更新代码时不要删这个目录 |
| Docker | `-v turtle-data:/data -e DATA_DIR=/data`，不要用 `docker rm` 删除卷 |

另外提供两个脚本做备份 / 恢复：

```bash
npm run data:backup     # 复制 data/db.json 到 backups/db-<时间戳>.json
npm run data:restore -- backups/db-2026-11-09T12-00-00-000Z.json   # 恢复（重启服务后生效）
```

`backups/` 已加入 `.gitignore`；建议用 cron / 计划任务每天备份，并同步到对象存储或另一台机器。

> `submissions/` 里的投稿文件在仓库里，重新部署不会丢；`data/db.json` 只存计数和缓存，丢了题库能自动重建，但翻煮次数和喜欢会归零——所以持久化目录才是关键。

> 这是单进程、单机文件存储的设计，适合个人或小站。不要同时起多个实例指向同一个数据文件。

## 联机怎么玩（主持人模式）

1. 进入「联机」第一屏，填名字 → **创建房间**，你成为**主持人**
   - 开桌方式选「自己出题」或「题库开桌」
2. 把房间码 / 邀请链接发给朋友，其他人打开链接或在大厅填房间码 **加入房间**
3. 房间里所有人（包括主持人）都在**准备区**：
   - 玩家点 **我准备好了**（可以再点取消准备）
   - 主持人等所有人都准备好后，**开始游戏** 按钮才会亮起
4. 主持人点 **开始游戏** → 弹出窗口只填 **汤面**（标题可选；题库开桌可先选题）
   → 确定后房间立刻切换到游戏状态，汤面**广播**给所有人，聊天框此时才开放
5. 游戏开始后（只有开局后），聊天框上方可以切换 **公共 / 私聊**：
   - 公共：房间里所有人都能看到（主持人发的公共消息、玩家的普通聊天）
   - 私聊：选一个对象，其他玩家看不到；**主持人可以看到房间里所有私聊**（用来判定问题是否作弊、调整提示）
6. 玩家在聊天框提问，主持人点每条提问下的 **是 / 否 / 无关**
   - 玩家想要提示：点 **请求提示** → 主持人 **同意并写提示**（提示公开）/ **不同意**（发起人会收到通知）
   - 主持人也可以随时点 **给提示** 自己公布一条
   - 玩家输入推理 **猜汤底**，命中即自动揭晓
7. 主持人可以给玩家 **分配二级身份**（聊天区上方「分配二级身份」）：选择给谁、填写名称 / 简介 / 目的
   - **只有被分配的玩家自己**会在汤面下方看到自己的身份卡片和一条「你的身份」消息，其他玩家完全看不到
   - **主持人**在玩家列表里看到每个人被分配了哪些身份（身份一览含简介与目的），并可收回
   - 换一道新汤（开始下一局）时身份自动清空
8. 主持人点 **结束本局** → 弹出窗口填写 **汤底** → 确定后汤底公布给所有人
9. 主持人点 **回到准备**：房间**不解散**，所有人重新准备（玩家重新点准备、主持人再点开始）即可继续下一局
7. 随时可改名；主持人离开会自动移交给在线玩家；主持人可以结束房间

规则细节：
- 准备阶段里，只要还有玩家没准备（包括离线玩家），主持人都无法开始
- 房间里至少有 1 名玩家才能开始游戏
- 局中有人新加入时，房间会回到准备阶段，避免新来的玩家看不到汤面
- 汤底只在揭晓后下发；答题期间玩家端拿不到汤底与未放的提示
- 房间码 6 位（去掉 `0O1I5S`），单房最多 12 人，没有任何人在线的房间 30 分钟后回收
- 掉线 10 分钟内原浏览器自动重连，席位不释放

## 部署到 Railway（从 GitHub 自动更新）

仓库里已带 `railway.json`，Railway 会自动用 Nixpacks 构建、`npm start` 启动，健康检查走 `/api/health`。

**第一次部署**

1. Railway → **New Project** → **Deploy from GitHub repo** → 选择 `turtle-soup`
2. 授权 Railway GitHub App 访问这个仓库
3. 服务里进入 **Settings → Networking → Generate Domain**，拿到公网域名

**之后改完代码怎么更新**

- 正常情况：本地 `git push` 到 `main` 后，Railway 检测到新提交会**自动重新部署**（服务 Settings → Source 里的 Autodeploy 保持开启）
- 手动部署最新提交：在 Railway 项目里按 `Ctrl/Cmd + K` → **Deploy Latest Commit**
- 也可以用命令行：`npm i -g @railway/cli` → `railway login` → `railway link` → `railway up`（直接上传本地代码，不依赖 GitHub）

**环境变量（可选）**

| 变量 | 说明 |
| --- | --- |
| `ADMIN_KEY` | 设置后可用管理员密钥删除题库里的汤 |
| `DATA_DIR` | 数据目录；**默认 `./data` 在容器重建后会丢**，要长期保存请挂 Volume |

**数据持久化（重要）**

Railway 每次重新部署会重建容器，`./data` 里的 `db.json` 会重置为内置题库。想让投稿/房间快照保留：

1. 服务 → **Variables → New Variable → Add Volume**（或 Settings → Volumes），挂载路径填 `/data`
2. 增加环境变量 `DATA_DIR=/data`
3. 重新部署一次

不介意数据重置的话可以跳过（内置 10 道题库每次都会自动写入）。

**注意**

- Railway 默认给 `PORT` 环境变量，代码已自动读取，不用手动配置
- 联机依赖 SSE，Railway 边缘代理支持流式响应，无需额外配置

## 部署到云服务器

### 方式一：直接跑

```bash
# 服务器装好 Node 18+ 之后
git clone <你的仓库地址> turtle-soup
cd turtle-soup
npm install --omit=dev
ADMIN_KEY='换成随机串' PORT=3300 nohup node server.js > app.log 2>&1 &
```

### 方式二：systemd 守护（推荐）

`/etc/systemd/system/turtle-soup.service`：

```ini
[Unit]
Description=Turtle Soup
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/turtle-soup
ExecStart=/usr/bin/node server.js
Environment=PORT=3300
Environment=HOST=127.0.0.1
Environment=DATA_DIR=/var/lib/turtle-soup
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/turtle-soup
sudo systemctl daemon-reload
sudo systemctl enable --now turtle-soup
```

### Nginx 反向代理（含 HTTPS、SSE 关键配置）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 实时房间依赖 SSE：必须关掉缓冲，并放宽超时
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        add_header X-Accel-Buffering no;
    }
}
```

用 `certbot --nginx` 加 HTTPS 后，复制房间链接分享给朋友即可。

### Docker（可选）

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3300 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3300
CMD ["node", "server.js"]
```

## API 速览

单机：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stories?page=&size=&q=&tag=&sort=&source=` | 题库列表（sort: new / hot / like / random；source=pr 只看玩家投稿） |
| GET | `/api/stories/:id` | 汤面 + 提示（汤底不预下发） |
| GET | `/api/stories/random` | 随机一道 |
| POST | `/api/stories/:id/hint` | `{count}` 取前 N 条提示 |
| POST | `/api/stories/:id/answer` | `{answer}` 提交推理，返回 `{correct}`，命中时附带 `solution` |
| POST | `/api/stories/:id/reveal` | 标记已揭晓并返回 `{solution}` |
| POST | `/api/stories/:id/like` | `{like:true/false}` |
| POST | `/api/stories` | 投稿 |
| DELETE | `/api/stories/:id` | 需 `ADMIN_KEY` |

联机：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/rooms` | 进行中的房间（两类模式都在里面） |
| POST | `/api/rooms` | 创建房间：`{name, mode: "custom" \| "preset"}`，创建者即主持人 |
| POST | `/api/rooms/:code/ready` | 准备 / 取消准备：`{token,ready:true/false}` |
| POST | `/api/rooms/:code/start` | 主持人开始游戏：`{token,title,surface,solution?}`（汤底可选，填了玩家才能猜中） |
| POST | `/api/rooms/:code/hint-request` | 玩家请求提示：`{token,text}` |
| POST | `/api/rooms/:code/hint-answer` | 主持人回应提示请求：`{token,messageId,accept,text}` |
| POST | `/api/rooms/:code/role` | 分配二级身份：`{token,memberId,name,desc,goal}` |
| POST | `/api/rooms/:code/role-clear` | 收回身份：`{token,memberId}` |
| POST | `/api/rooms/:code/end` | 主持人结束本局并公布汤底：`{token,solution}` |
| POST | `/api/rooms/:code/next-round` | 主持人宣布准备下一轮 |
| POST | `/api/rooms/join` | 加入：`{code,name}` → `token` |
| POST | `/api/rooms/resume` | 断线重连：`{code,token}` |
| GET | `/api/rooms/:code/events?token=` | SSE：`room` / `you` / `messages` / `closed` |
| POST | `/api/rooms/:code/puzzle` | 主持人出题 / 换题：`{token,title,surface,solution,hints}` |
| POST | `/api/rooms/:code/use-story` | 主持人从题库选题：`{token,storyId}` |
| POST | `/api/rooms/:code/story` | 主持人选题时取完整题目（含汤底）：`{token,storyId}` |
| POST | `/api/rooms/:code/chat` | 公共聊天：`{token,text}` |
| POST | `/api/rooms/:code/whisper` | 私聊：`{token,toId,text}`（推送给双方 + 主持人） |
| POST | `/api/rooms/:code/ask` | 玩家提问：`{token,text}` |
| POST | `/api/rooms/:code/answer` | 主持人回答：`{token,messageId,answer:yes/no/irrelevant}` |
| POST | `/api/rooms/:code/hint` | 主持人主动公布提示：`{token,text}` |
| POST | `/api/rooms/:code/say` | 主持人补充说明 |
| POST | `/api/rooms/:code/guess` | 猜汤底：`{token,text}` |
| POST | `/api/rooms/:code/reveal` | 主持人公布汤底 |
| POST | `/api/rooms/:code/host` | 轮末交接主持人：`{memberId}` |
| POST | `/api/rooms/:code/rename` | 改名：`{token,name}` |
| POST | `/api/rooms/:code/leave` | 离开房间 |
| POST | `/api/rooms/:code/close` | 主持人结束房间 |

## 投稿（Pull Request）

出题不再通过网页直接发布：

- “出题”页（`/new`）只提供教程，并把 `POST /api/stories` 关闭为 403；
- 投稿人 Fork 仓库 → 在 `submissions/` 下新增 JSON → 提交 PR（标题以 `[汤]` 开头，使用“海龟汤投稿”模板）；
- 维护者**人工核查**内容与合规后合并；合并后的文件在下次启动 / 部署时自动加载进题库（删除文件并重新部署即下架），并出现在独立的「玩家投稿」页（`/community`）；
- 标签可选、最多 2 个，只能从固定白名单里选（经典 / 悬疑 / 恐怖 / 悲伤 / 温暖 / 轻松 / 推理 / 脑洞 / 科幻 / 日常），非白名单标签会被直接丢弃；
- 普通代码 / 文档 PR 使用默认模板、标题不加 `[汤]`，两类 PR 互不干扰。

## 目录结构

```
.
├── server.js              # Express 入口、单机 / 联机 / 投稿 API、静态资源
├── src/
│   ├── store.js           # 题库持久化（data/db.json）+ 合并 submissions/
│   ├── stories.js         # 内置题库
│   ├── rooms.js           # 联机房间：主持人模式、SSE、身份、快照恢复
│   ├── ratelimit.js       # 简易限流
│   ├── tags.js            # 标签白名单
│   └── submissions.js     # 加载 submissions/ 下已合并的 PR 稿件
├── submissions/           # 海龟汤投稿目录（每个 .json = 一道汤）
├── .github/PULL_REQUEST_TEMPLATE/  # 海龟汤 / 普通 PR 两套模板
├── tools/
│   ├── backup-data.mjs    # 备份 data/db.json 到 backups/
│   └── restore-data.mjs   # 从备份恢复
└── public/
    ├── index.html
    └── assets/
        ├── style.css      # 黑白主题、动画、响应式
        ├── app.js         # 题库 + 玩家投稿页 + 投稿教程
        ├── rooms.js       # 联机大厅与房间
        ├── favicon.svg
        └── fonts/         # 仿宋字体子集（woff2）
```

## 字体

全站使用**朱雀仿宋**（Zhuque Fangsong，SIL Open Font License 1.1），已裁剪为仅包含常用字与界面文字的 woff2 子集（约 2.5 MB），字体文件自托管，不依赖第三方 CDN。
需要显示更生僻的字时，可以用 `fonttools` 以同样的方式重新生成子集，替换 `public/assets/fonts/` 下的文件即可。

## 安全与注意事项

- 联机身份用随机 token 区分，**不要**把带 token 的接口地址公开分享；分享用 `/room/:code` 链接。
- 汤底只在「揭晓」后才下发给浏览器；联机房间中，提问和回答在房间内公开。
- 投稿已改为 GitHub Pull Request：`POST /api/stories` 固定返回 403，网页不再直接写题库。

## License

MIT
