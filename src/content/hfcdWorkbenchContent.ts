export type HFCDWorkbenchCopy = {
  heroBadge: string;
  heroTitle: string;
  heroSubtitle: string;
  heroPrimaryCta: string;
  heroSecondaryCta: string;
  valueCardTitle: string;
  valueProofTitle: string;
  valueProofBody: string;
  valueCauseTitle: string;
  valueCauseBody: string;
  valuePlanTitle: string;
  valuePlanBody: string;
  dashboardTitle: string;
  dashboardDescription: string;
  blindFlowTitle: string;
  blindFlowDescription: string;
  blindFlowPointInput: string;
  blindFlowPointOutput: string;
  blindFlowPointUse: string;
  blindFlowAction: string;
  researchFlowTitle: string;
  researchFlowDescription: string;
  researchFlowPointInput: string;
  researchFlowPointOutput: string;
  researchFlowPointUse: string;
  researchFlowAction: string;
  uploadTitle: string;
  uploadDescription: string;
  blindTitle: string;
  blindDescription: string;
  blindInstructionTitle: string;
  blindInstructionBody: string;
  blindUploadButton: string;
  researchTabLabel: string;
  researchTitle: string;
  researchDescription: string;
  researchQuickTitle: string;
  researchQuickDescription: string;
  researchQuickButton: string;
  researchSubmitTitle: string;
  researchSubmitDescription: string;
  researchSubmitButton: string;
  reportsTitle: string;
  reportsDescription: string;
};

export const hfcdWorkbenchDefaultCopy: HFCDWorkbenchCopy = {
  heroBadge: 'R&D Risk Validation',
  heroTitle: '把研发数据变成可执行的升级方案',
  heroSubtitle:
    '上传历史实验、生产或质检数据，系统会找出最可能拖垮项目的风险样本，解释主要失效原因，并给出下一轮研发优先动作。已有真实失效记录时，还可以直接验证它是否比现有方法更早发现问题。',
  heroPrimaryCta: '验证风险预警能力',
  heroSecondaryCta: '获取研发升级方案',
  valueCardTitle: '产品价值',
  valueProofTitle: '先证明能发现风险',
  valueProofBody:
    '用客户历史失效记录做验证，直接看高风险样本命中率、相对原方法提升和平均提前预警天数。',
  valueCauseTitle: '再解释为什么危险',
  valueCauseBody:
    '不是只给一个黑箱分数，而是把风险拆成研发团队能讨论的原因：状态漂移、负荷过高、支撑不足、扩散失控或交付不稳。',
  valuePlanTitle: '最后给出升级动作',
  valuePlanBody:
    '把候选修复路线、结果图表、CSV、summary、checkpoint 和运行日志整理成可下载的研发方案包。',
  dashboardTitle: '用一份历史数据，先看清风险，再决定下一步研发怎么改',
  dashboardDescription:
    '系统会把客户已有数据转成三类结果：哪些样本最危险、为什么危险、下一轮应该先修哪条研发路径。若有真实失效标签，还能直接验证预警能力；需要更深复核时，再提交云端长程任务生成完整报告和证据链。',
  blindFlowTitle: '验证风险预警能力',
  blindFlowDescription:
    '上传带真实失效标签的历史数据，系统会把高风险样本排在前面，并计算命中率、相对客户原方法的提升，以及平均提前预警天数。',
  blindFlowPointInput: '输入：历史实验、生产或质检数据，并提供 actual_failure 真实失效标签。',
  blindFlowPointOutput: '输出：高风险样本、主要失效原因、Top10 命中率、AUC、提前预警天数。',
  blindFlowPointUse: '用途：快速判断这套方法是否值得进入客户试点或联合研发。',
  blindFlowAction: '进入验证',
  researchFlowTitle: '获取研发升级方案',
  researchFlowDescription:
    '当客户需要进一步确认研发路线时，提交云端任务生成完整的升级方案包：候选修复路径、结果图表、CSV、summary、checkpoint 和运行日志。',
  researchFlowPointInput: '输入：实验版本、checkpoint、运行规模和云端任务参数。',
  researchFlowPointOutput: '输出：可下载报告、图表、CSV、summary、checkpoint 和运行日志。',
  researchFlowPointUse: '用途：从快速验证升级到研究级复核和下一轮研发路线选择。',
  researchFlowAction: '生成升级方案',
  uploadTitle: '上传数据：先跑通一次真实业务流程',
  uploadDescription:
    '选择行业后，页面会告诉你该上传哪些字段。可以先加载示例数据看完整流程，再换成客户自己的历史实验、生产、校准、寿命或质检 CSV。',
  blindTitle: '验证预警能力',
  blindDescription:
    '上传带真实失效标签的历史数据，系统会把高风险样本排在前面，并计算命中率、相对客户原方法的提升，以及平均提前预警天数。',
  blindInstructionTitle: '上传一份带真实结果的历史数据',
  blindInstructionBody:
    'CSV 至少需要 actual_failure 字段：真实失效填 1，未失效填 0。可选补充 baseline_score 用于和客户现有模型对比，补充 lead_time_days 用于统计提前预警天数。',
  blindUploadButton: '上传并验证',
  researchTabLabel: '获取研发升级方案',
  researchTitle: '获取研发升级方案',
  researchDescription:
    '这里会提交云端任务，生成一份研发升级方案包。系统会运行 HFCD 长程脚本，保存报告、图表、CSV、summary、checkpoint 和运行日志，方便团队复核每条候选路线。',
  researchQuickTitle: '先生成一版快速升级方案',
  researchQuickDescription:
    '先用小规模任务确认数据、云端运行和结果读取正常；确认通过后，再扩大运行规模做更完整的研发路线复核。',
  researchQuickButton: '生成快速方案',
  researchSubmitTitle: '提交研发方案任务',
  researchSubmitDescription:
    '任务会在云端运行 Python 长程脚本。建议先用快速验证模式确认链路，再放大候选路线数量和 checkpoint 数。',
  researchSubmitButton: '提交生成升级方案',
  reportsTitle: '结果中心',
  reportsDescription:
    '这里统一保存风险验证报告和研发升级方案包。风险验证报告用于证明能不能发现问题；升级方案包用于复核候选研发路线和下载证据文件。',
};
