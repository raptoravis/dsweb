# dsweb

一个多用户 web 应用：frontend 提供对话历史面板，backend 承载鉴权与账号并驱动 deepseek-harness（dsh）作为 agent 引擎。

## Language

**用户 (User)**:
持有账号、可登录的个体；每个用户拥有完全隔离的私有对话空间，用户之间互不可见。
_Avoid_: 账号, 客户

**对话 (Conversation)**:
面板里的一条独立线程，归属一个用户；可命名/重命名、删除、列表展示，仅文本输入，内部是用户与 agent 的往来。
_Avoid_: 会话, 线程, chat

**对话历史 (Conversation history)**:
一个用户全部对话的集合，「对话历史面板」据此展示。

**Agent trace (执行轨迹)**:
一次对话中 agent 为响应用户而进行的工具调用与步骤序列；面板默认折叠、可展开查看完整过程。
_Avoid_: 日志, 运行记录
