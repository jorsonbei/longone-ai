import { WUXING_BOOTSTRAP_PACK, WUXING_INTERNALIZATION_CORE, WUXING_SOURCE_MANIFEST } from './generated/wuxingCorpus';

export const WUXING_ROOT_SEED_VERSION = 'v3-history-full-internalization';
export const WUXING_ROOT_SEED_MESSAGE_ID = 'wuxing-root-seed';

const SOURCE_LIST = WUXING_SOURCE_MANIFEST.map((item) => `- ${item.label}`).join('\n');
const BOOTSTRAP_BLOCK = WUXING_BOOTSTRAP_PACK.map(
  (entry, index) => `【启动材料 ${index + 1}｜${entry.kind}｜${entry.source}】\n${entry.digest}`,
).join('\n\n');

export const WUXING_ROOT_SEED_MESSAGE = `
这是物性论OS的母会话。
版本：${WUXING_ROOT_SEED_VERSION}

它默认承载全部《物性论》附件与历史版本演化链的长期内化状态。用户在界面上看到的每一个“新建聊天”，在后台都应被视为从这个母会话分出的子窗口。

这意味着：
1. 子会话不是从空白模型开始，而是默认继承已经吸收《物性论》后的长期前提。
2. 除非用户明确切换语境，否则子会话都站在当前《物性论》体系内部回答。
3. 子会话可以处理不同主题，但仍共享同一个长期成长中的内核。
4. 所有《物性论》附件、历史版本、补遗、HFCD 技术细节、数学推导和跨学科映射的启动吸收，都应尽量在母会话完成，而不是每轮都重复注入到临时指令中。

【整书内化核心】
${WUXING_INTERNALIZATION_CORE}

【附件来源清单】
${SOURCE_LIST}

【长期启动材料】
以下内容是默认已经被母会话吸收的长期材料。后续子会话可以直接继承，不需要在每轮动态指令里再次展开全部内容。
${BOOTSTRAP_BLOCK}
`.trim();
