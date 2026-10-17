# Contextual AI-tell review

Use after composing a draft or for requested lint review. An honest pass is allowed. Patterns are diagnostic candidates, not banned words or a sentence-generation recipe.

## AI-tell review mode

Use these patterns in two distinct ways:

- **Composition self-check:** before handing over prose you authored, check the contextual patterns below from your own new language while preserving the owner's material and register.
- **Lint-review mode:** when reviewing existing prose, detection only. Report findings as quoted phrase + pattern name + one-line reason. Never bulk-rewrite; edits go through the owner's normal review loop.

The phrases below are candidate triggers, not banned words. A match is a finding only when it performs the listed pattern in context.

### Chinese patterns

| Pattern | Watch for |
| --- | --- |
| 夸大意义 | 标志着, 见证了, 是……的证明/体现, 关键时刻, 深深植根于, 不可磨灭的印记 |
| AI 词汇 | 此外, 值得注意的是, 至关重要, 深入探讨, 赋能, 打造, 格局, 交织, 织锦, 充满活力, 彰显 |
| 系动词回避 | 作为/充当/拥有/设有 where 是/有 is truer |
| 否定式排比 | 不仅……更是……, 这不仅仅是……而是…… |
| 三段式 | Three parallel items where two or four are truer (海浪、礁石和雾号声交织在一起) |
| 肤浅分析尾巴 | Sentence tails that fake depth: 展现了……, 彰显了……, 折射出……, 象征着……, 营造出……的氛围 |
| 宣传语言 | 令人叹为观止, 鬼斧神工, 丰富的（比喻）, 迷人的, 坐落于, 必游之地 |
| 模糊归因 | 专家认为, 有人指出, 行业报告显示, with no checkable source |
| 同义词循环 | Rotating labels for one referent (主人公/主要角色/中心人物); flag only mechanical rotation, a label that adds information stays |
| 虚假范围 | 从X到Y where X and Y sit on no real scale |
| 填充短语 | 在这个时间点, 为了实现这一目标, 值得一提的是, 具有……的能力 |
| 空泛积极结尾 | 未来可期, 收获了成长, 继续追求, 见证更多的美好 |
| 格式痕迹 | Bold inline-header bullets (**X：** …), decorative emoji on headings/lists, em-dashes (already banned by repo rule 2) |

### English patterns (translations)

| Pattern | Watch for |
| --- | --- |
| Inflated significance | stands as a testament, marks a pivotal moment, underscores, rich tapestry, ever-evolving landscape |
| AI vocabulary | moreover, furthermore, delve, seamless, robust, vibrant, crucial, foster, showcase |
| Negative parallelism | not just X, but Y; it isn't about X, it's about Y |
| Rule of three | forced triads of adjectives or clauses |
| Vague attribution | experts say, observers note, industry reports show, with no checkable source |
| -ing analysis tails | trailing participles that fake depth: …, highlighting…, …, reflecting…, …, ensuring… |
| Generic endings | The future looks bright, an unforgettable experience, In conclusion |

### Do NOT flag

- 😂 and wry domestic humor: explicitly welcome in this blog.
- Short fragments and punchy sentences: concision is his style, not a tell.
- Curly or CJK quotes (「」 ""): correct Chinese typography, not a tell.
- Three-item lists that are literally true (a real shopping list). Flag the mechanism only when it fakes rhythm or depth.
- Repetition the owner wrote deliberately.

When a lint-review finding is borderline, report it marked "borderline, your call" instead of silently fixing or silently passing it.

### Output format

In lint-review mode, give numbered findings in text order, each: quoted phrase, pattern name, one-line reason. End with any plausible candidates you deliberately passed, not an exhaustive list of absent patterns. Do not invent quality scores or produce a rewritten full text unless requested.


The historical project patterns were distilled from [op7418/humanizer-zh](https://github.com/op7418/humanizer-zh), MIT, by 歸藏, based on Wikipedia’s “Signs of AI writing.” Its emoji ban, curly-quote ban, numerical rubric, and bulk-rewrite workflow do not apply here.
