# VS Code sidebar fixture

viewport: 259x900
uncontained-outside-elements: 0
root-horizontal-scroll: false
horizontal-scrollers: 1

## Sessions route
- button "New session"
- button "Collapse sidebar":
  - img
- button "New session":
  - img
  - text: New Session
- text: Workspaces
- button "Group by":
  - img
- button "Search sessions":
  - img
- textbox "Search name, keywords..."
- tree "Sessions":
  - treeitem "fixture 4 sessions" [expanded]:
    - img
    - text: fixture 4 sessions
  - treeitem "New Session" [selected]
  - treeitem "Waiting for approval Fixture 历史会话 now"
  - treeitem "fixture 1min"
  - treeitem "fixture 2min"
- button "Settings":
  - img
  - text: Settings

## Question
- region "你现在更想招哪类 Agent/Harness 候选人？":
  - text: 偏好
  - heading "你现在更想招哪类 Agent/Harness 候选人？" [level=2]
  - button "Dismiss all questions":
    - img
  - radiogroup:
    - radio "工程落地型": 1 工程落地型 Recommended 更看重能直接做 runtime、tool executor、sandbox、trace 和线上问题排查。
    - radio "研究潜力型": 2 研究潜力型 更看重 Agent 理解、训练评测思路和长期成长空间。
    - radio "均衡型": 3 均衡型 同时要求工程能力和 Agent 认知，但可能筛选门槛更高。
    - textbox "Type your answer"
  - button "Previous question" [disabled]:
    - img
  - text: 1 / 3
  - button "Next question":
    - img
  - status
  - button "Skip this question"
  - button "Next" [disabled]

## Approval
- text: Waiting for approval
- group "Approval details": fixture 常驻审批（可答：批准/拒绝后消失）
- button "Reject"
- button "Allow once"

## Bash tool row
- img
- text: Bash List notes

## Web search tool row
- button "Search deepseek harness architecture":
  - img
  - img
  - text: Search deepseek harness architecture
