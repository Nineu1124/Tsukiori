# Tsukiori V1.1 ImageGen 提示词

生成模式：Codex 内置 `image_gen`。输入图片仅作为当前产品风格与布局参考，所有结果均为新生成的原创位图。

## 1. 完整产品视觉总板

```text
Use case: ui-mockup
Asset type: complete desktop application visual design board for Tsukiori
Input images: current project dashboard, session conversation, workspace and settings screenshots are style and layout references; preserve their visual DNA, proportions, and information density, but create a refined next-iteration design board rather than editing one screenshot.
Primary request: create one polished 16:9 presentation board showing six coherent desktop UI views of a local multi-agent developer workstation: project dashboard, agent conversation with tool activity, right work panel with files and diff, runtime/provider capability hub, settings navigation, and onboarding/empty state.
Style/medium: shippable realistic desktop product UI mockup, futuristic academy operating-system aesthetic, crisp vector-like interface, not concept art.
Composition/framing: one landscape design board with a large hero screen and five smaller screen/detail crops arranged on a precise grid; clear hierarchy and generous margins.
Color palette: deep navy #14243d, white, ice blue #dceefa, bright cyan #249ce8, pale cyan linework, restrained yellow #ffd45c action accent, small mint and violet status accents.
Materials/textures: flat matte UI surfaces, 1px cyan technical rules, angular clipped corners, diagonal hatch zones, blueprint grids, subtle translucent layers; minimal shadows.
Text: only short readable section labels such as "PROJECT", "SESSION", "FILES", "RUNTIME", "SETTINGS", "ONBOARDING"; render each exactly once, no other dense copy.
Constraints: preserve a practical 1600x1000 desktop app proportion, left navigation rail, central workspace, optional right work panel and bottom terminal; show resizable pane affordances; consistent component system; original graphics only; no characters, no copyrighted logos, no watermark.
Avoid: dark full-screen theme, rounded consumer-app cards, neon cyberpunk glow, excessive gradients, illegible tiny text, random icons, mobile layouts.
```

## 2. Onboarding 主视觉

```text
Use case: stylized-concept
Asset type: Tsukiori desktop onboarding hero background
Primary request: create an original wide background illustration for the onboarding screen of a local multi-agent developer workstation, inspired by the same blue-white academy technology interface language.
Scene/backdrop: clean white-to-ice-blue matte background with very subtle blueprint grid and technical measurement marks.
Subject: an abstract orbital constellation of five connected agent nodes around a central four-point Tsukiori star, with branching worktree rails and small geometric data modules; no people or characters.
Style/medium: crisp flat vector-like technical illustration, precise and production-ready.
Composition/framing: 16:9 landscape; main illustration concentrated on the right 55%; large calm negative space on the left for onboarding headline and buttons; no border around the whole image.
Color palette: deep navy #14243d, bright cyan #249ce8, pale blue #dceefa, white, restrained yellow #ffd45c, tiny mint status accents.
Constraints: no text, no logos, no characters, no watermark; original design; practical as a CSS background; no checkerboard transparency pattern.
```

## 3. Project / Worktree 主视觉

```text
Use case: stylized-concept
Asset type: Tsukiori project dashboard hero illustration
Primary request: create an original wide technical illustration representing a Git project split into isolated agent worktrees and later merged safely.
Scene/backdrop: clean white and very pale ice-blue drafting surface with faint grid, brackets, ruler ticks, and diagonal hatch.
Subject: three angular layered code-workspace modules branching from one source rail, with thin cyan connection lines and one converging integration node; abstract objects only, no text labels.
Composition/framing: panoramic 2.4:1 layout; visual cluster on the right 62%; quiet negative space on the left for project name and path; clear silhouette at small size.
Color palette: navy #14243d, cyan #249ce8, pale blue, white, restrained yellow #ffd45c, tiny mint validation markers.
Constraints: no text, no logos, no characters, no watermark; full rectangular background; no checkerboard.
```

## 4. Capability Hub

```text
Use case: stylized-concept
Asset type: Tsukiori Runtime and capabilities settings illustration
Primary request: create an original technical capabilities map illustrating a local multi-agent host connecting Runtime, Provider, MCP, Skills, Memory, Agent Team, scheduled tasks, Git, and Computer Use as modular nodes.
Scene/backdrop: white and ice-blue blueprint surface with restrained navy technical frame.
Subject: one central angular host core surrounded by eight distinct geometric modules connected through clean rails; recognizable abstract symbols only, no words and no third-party logos.
Composition/framing: landscape 4:3; central cluster; generous outer margins; visual hierarchy readable at 480px wide.
Color palette: navy #14243d, cyan #249ce8, pale blue #dceefa, white, yellow #ffd45c, mint #47d7b1, violet #8c78ff.
Constraints: no text, no logos, no people, no characters, no watermark; full rectangular background; original design.
```

## 5. 工作面板水印

```text
Use case: stylized-concept
Asset type: Tsukiori right work-panel watermark illustration
Primary request: create a subtle vertical operations gateway motif for the lower empty region of Tsukiori's right work panel, evoking a local agent portal and task handoff.
Scene/backdrop: very light white-to-ice-blue matte field with faint technical grid.
Subject: a tall angular portal frame built from nested cyan and navy outlines, a small four-point star/crosshair at its center, branching circuit paths and restrained measurement ticks.
Composition/framing: portrait 3:4; motif anchored in the lower two-thirds; generous blank space at top for panel content; safe crop on all sides.
Constraints: no text, no logos, no people, no characters, no watermark; low contrast; full rectangular light background; no checkerboard.
```

## 6. 多 Agent 空状态

```text
Use case: stylized-concept
Asset type: Tsukiori compact empty-state illustration for Agent Team, Skills, MCP, Memory, and scheduled-task panels
Primary request: create one reusable compact illustration representing an idle local multi-agent constellation waiting for configuration.
Scene/backdrop: deep navy #14243d technical panel, matte and clean.
Subject: central four-point star surrounded by four small angular agent modules connected by thin cyan rails, all enclosed in a clipped rectangular command frame; one small yellow route segment and mint ready indicator.
Composition/framing: landscape 4:3, centered emblem, generous internal padding, clear silhouette at 240px wide.
Color palette: deep navy, white linework, cyan #249ce8, pale blue, restrained yellow #ffd45c, mint #47d7b1.
Constraints: no text, no logos, no characters, no watermark; full rectangular navy background; original design.
```
