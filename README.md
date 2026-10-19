# CCPC 新模式榜单

适用于 `rank.iccpc.cn` 的油猴脚本，保留原站排名、筛选和时间回放。

## 安装

1. 在 Tampermonkey 中新建脚本。
2. 粘贴 [ccpc-new-board.user.js](ccpc-new-board.user.js) 的全部内容并保存。
3. 刷新榜单，标题下出现“新模式：已开启”即可使用；点击按钮可关闭。

在[示例榜单](https://rank.iccpc.cn/r/8884583c-c577-4379-90c5-783f103ad910)中，将时间进度条拖回比赛早期可查看匿名效果。

## 规则

- 左侧按题号展示已公开题目；右侧隐藏题号和一血，AC 优先并按通过时间排序，未 AC 按最近提交时间排序。
- `min(50, 20% × 正式队伍数)` 支队伍通过后公开题号，打星队的 AC 也计入。
- 满 4 小时公开全部题号，后续提交显示为黄色封榜状态。

完整规则见[新模式规则](新模式规则.md)。脚本仅改变本地展示，不能替代服务端的数据隐藏。

## 验证

```sh
npm test
npm run check
```

浏览器集成测试的运行方式见 [tests/browser-smoke.cjs](tests/browser-smoke.cjs)。
