import dotenv from 'dotenv';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { MODELS } from '../src/services/geminiService';
import { analyzeWuxingInput, DEFAULT_WUXING_CONFIG } from '../src/lib/wuxingKernel';
import { buildInternalizedOperatingInstruction } from '../src/lib/wuxingInternalization';
import { normalizeMessageOrder } from '../src/lib/messageOrdering';
import {
  auditRecords,
  generateMarkdownReport,
  HFCD_INDUSTRIES,
  learnHFCDParameters,
  parseCsv,
  runHFCDFieldSimulation,
  simulateHFCDScenarios,
  summarizeAudit,
  summarizeGateSafety,
  templateToCsv,
  validateBlindMetrics,
  validateRows,
} from '../src/lib/hfcdCore';
import {
  buildHFCDResearchCloudConfig,
  buildHFCDResearchJobPlan,
} from '../src/lib/hfcdResearchJobs';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

async function pingModel(ai: GoogleGenAI, model: string) {
  const result = await Promise.race([
    ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: '你好' }] }],
      config: { temperature: 0.1 },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Model ${model} timed out during self-test.`)), 20_000),
    ),
  ]);

  const text = (result as { text?: string }).text || '';
  assert(text.trim().length > 0, `Model ${model} returned an empty response.`);
  console.log(`[self-test] ${model} OK`);
}

async function pingWithFallback(ai: GoogleGenAI, preferredModel: string, fallbackModel: string) {
  try {
    await pingModel(ai, preferredModel);
  } catch (error) {
    console.warn(
      `[self-test] ${preferredModel} unavailable, validating fallback ${fallbackModel}.`,
      error instanceof Error ? error.message : String(error),
    );
    await pingModel(ai, fallbackModel);
  }
}

async function generateWithFallback(
  ai: GoogleGenAI,
  prompt: string,
  preferredModel: string,
  fallbackModel: string,
) {
  try {
    const result = await ai.models.generateContent({
      model: preferredModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.1 },
    });
    return result.text || '';
  } catch {
    const result = await ai.models.generateContent({
      model: fallbackModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.1 },
    });
    return result.text || '';
  }
}

async function main() {
  const orderedMessages = normalizeMessageOrder([
    {
      id: 'answer-current',
      role: 'model',
      content: 'answer',
      createdAt: 1000,
      status: 'completed',
      replyToId: 'question-current',
    },
    {
      id: 'question-current',
      role: 'user',
      content: 'question',
      createdAt: 1000,
      status: 'completed',
    },
    {
      id: 'question-next',
      role: 'user',
      content: 'next',
      createdAt: 1002,
      status: 'completed',
    },
  ]);
  assert(
    orderedMessages.map((message) => message.id).join(',') === 'question-current,answer-current,question-next',
    'Message ordering should keep each user question above its model answer.',
  );
  console.log('[self-test] message ordering OK');

  const quantumRows = parseCsv(templateToCsv('quantum'));
  const quantumValidation = validateRows(quantumRows, 'quantum');
  assert(quantumValidation.isValid, 'HFCD quantum template should pass required-field validation.');
  assert(
    quantumValidation.fieldHealth.some((field) => field.key === 'T1_us' && field.present && field.hfcdGate === 'Q_error'),
    'HFCD field health should explain T1_us as a Q_error driver.',
  );
  assert(HFCD_INDUSTRIES.quantum.fields.some((field) => field.key === 'actual_failure'), 'HFCD quantum template missing actual_failure field.');
  const quantumResults = auditRecords(quantumRows, 'quantum');
  assert(quantumResults.length === 1, 'HFCD audit should return one result for one template row.');
  assert(quantumResults[0].failure_mode, 'HFCD audit result should classify a FailureMode.');
  assert(quantumResults[0].repair_plan.length > 0, 'HFCD audit result should generate a repair plan.');
  assert(quantumResults[0].readable.businessSummary.length > 0, 'HFCD audit result should generate a readable business diagnosis.');
  assert(quantumResults[0].readable.hfcdSummary.includes('系统判定'), 'HFCD audit result should generate readable key-indicator evidence.');
  const quantumSummary = summarizeAudit(quantumResults);
  assert(quantumSummary.sampleCount === 1, 'HFCD summary sample count mismatch.');
  const gateSafety = summarizeGateSafety(quantumResults);
  assert(gateSafety.length === 7, 'HFCD gate safety summary should include seven gates.');
  const blindMetrics = validateBlindMetrics(quantumResults);
  assert(blindMetrics.hasActualFailure, 'HFCD blind metrics should detect actual_failure labels.');
  const blindRows = parseCsv([
    'sample_id,T1_us,T2_us,T1_ref_us,T2_ref_us,gate2q_error,assignment_fidelity,job_success_rate,actual_failure,baseline_score,lead_time_days',
    'risk_1,50,42,90,80,0.04,0.82,0.62,1,0.40,18',
    'stable_1,90,82,90,80,0.004,0.98,0.98,0,0.35,0',
  ].join('\n'));
  const blindResults = auditRecords(blindRows, 'quantum');
  const enhancedBlindMetrics = validateBlindMetrics(blindResults);
  assert(enhancedBlindMetrics.baselineAuc !== undefined, 'HFCD blind metrics should include baseline comparison fields.');
  assert(enhancedBlindMetrics.warningLeadTimeAvg !== undefined, 'HFCD blind metrics should include warning lead-time fields.');
  const learnedProfile = learnHFCDParameters(blindRows, 'quantum');
  assert(learnedProfile.labeledCount === 2, 'HFCD parameter learning should detect labeled samples.');
  assert(learnedProfile.thresholds.Q_error > 0, 'HFCD parameter learning should generate usable thresholds.');
  const simulatedReport = simulateHFCDScenarios(blindRows, 'quantum', learnedProfile);
  assert(simulatedReport.scenarios.length >= 6, 'HFCD simulation should generate multiple R&D scenarios.');
  assert(simulatedReport.recommendedScenarioId !== 'baseline', 'HFCD simulation should recommend an actionable non-baseline scenario.');
  const fieldSimulationReport = runHFCDFieldSimulation({
    rows: blindRows,
    industry: 'quantum',
    profile: learnedProfile,
    input: {
      boundary: { timeHorizon: 48, gridResolution: 24 },
      scan: { candidateCount: 3, scanDepth: 0.5, stepSize: 0.06 },
    },
  });
  assert(fieldSimulationReport.model === 'hfcd-field-v1', 'HFCD field simulation should use the full field simulation model.');
  assert(fieldSimulationReport.candidates.length === 3, 'HFCD field simulation should honor candidate count.');
  assert(fieldSimulationReport.candidates[0].trajectory.length > 1, 'HFCD field simulation should generate multi-step trajectories.');
  assert(fieldSimulationReport.recommendedCandidateId !== 'baseline', 'HFCD field simulation should recommend an actionable route.');
  const hfcdReport = generateMarkdownReport({ projectName: 'HFCD 自测报告', industry: 'quantum', results: quantumResults });
  assert(hfcdReport.includes('Executive Summary'), 'HFCD report should include an executive summary.');
  assert(hfcdReport.includes('字段体检与解释'), 'HFCD report should include field explanations.');
  assert(hfcdReport.includes('样本诊断：业务解释 / 关键指标 / 修复方案'), 'HFCD report should include three-layer sample diagnosis.');
  assert(hfcdReport.includes('稳定性指标通过率'), 'HFCD report should include stability-indicator statistics.');
  const researchCloud = buildHFCDResearchCloudConfig({});
  assert(!researchCloud.enabled, 'HFCD research cloud config should require explicit cloud settings.');
  const researchPlan = buildHFCDResearchJobPlan({
    preset: 'v12_38_me28800',
    projectName: 'self-test',
    smoke: true,
    maxVariants: 3,
    topCheckpoints: 4,
  }, {
    HFCD_CLOUD_PROJECT_ID: 'demo-project',
    HFCD_CLOUD_REGION: 'us-central1',
    HFCD_CLOUD_RUN_JOB: 'hfcd-research-runner',
    HFCD_GCS_BUCKET: 'demo-bucket',
    HFCD_SOURCE_GCS_PREFIX: 'hfcd/source/current',
  }, 1_800_000_000_000);
  assert(researchPlan.experimentScript.includes('v12_38'), 'HFCD research plan should select the V12.38 script.');
  assert(researchPlan.artifactPrefix.includes('hfcd/research-jobs/'), 'HFCD research plan should create a GCS artifact prefix.');
  assert(researchPlan.outputGlobs.includes('ME28800'), 'HFCD research plan should preserve V12.38 output globs.');
  assert(researchPlan.env.HFCD_V1238_LOG_INTERVAL === '60', 'HFCD research smoke plan should shorten log interval.');
  console.log('[self-test] HFCD audit core OK');

  const nameCase = analyzeWuxingInput(
    '帮我给阮氏兰惠这个名字做结构解析，并说明她在物性论里的角色。',
    [],
    DEFAULT_WUXING_CONFIG,
  );
  assert(nameCase.names.some((item) => item.name === '阮氏兰惠'), 'Name parser did not detect 阮氏兰惠.');
  assert(nameCase.diagnosis.canonHits.some((item) => item.title === '阮氏兰惠'), 'Canon retrieval did not detect 阮氏兰惠.');
  assert(nameCase.diagnosis.canonHits.some((item) => item.authorRole?.includes('共同作者')), 'Canon author role missing for 阮氏兰惠.');
  assert(nameCase.diagnosis.recordRecommended, 'Record protocol should be recommended for name analysis.');
  console.log('[self-test] name parser OK');

  const relationCase = analyzeWuxingInput(
    '贝记胜、景龙锁、阮氏兰惠三者是什么关系？',
    [],
    DEFAULT_WUXING_CONFIG,
  );
  assert(relationCase.diagnosis.canonHits.length === 3, 'Relation query should hit all three canon entries.');
  assert(relationCase.diagnosis.canonRelations.length > 0, 'Relation query should build canon relationship graph.');
  console.log('[self-test] canon relation graph OK');

  const lockDragonCase = analyzeWuxingInput(
    '我最近总想哭，感觉被锁住了，明明想动却动不了。',
    [],
    DEFAULT_WUXING_CONFIG,
  );
  assert(lockDragonCase.diagnosis.lockDragon.state === 'releasing', 'Lock-dragon diagnosis should enter releasing state.');
  console.log('[self-test] lock-dragon diagnosis OK');

  const apiKey = process.env.GEMINI_API_KEY;
  assert(apiKey, 'Missing GEMINI_API_KEY for model self-test.');
  const ai = new GoogleGenAI({ apiKey });

  await pingWithFallback(ai, MODELS.FLASH, 'gemini-2.5-flash');
  await pingWithFallback(ai, MODELS.PRO, 'gemini-2.5-pro');

  const peopleQuestion = '阮氏兰惠和景龙锁是谁？';
  const peopleDiagnosis = analyzeWuxingInput(peopleQuestion, [], DEFAULT_WUXING_CONFIG).diagnosis;
  const peopleInstruction = buildInternalizedOperatingInstruction({
    baseInstruction: '请直接回答，不要空话。',
    systemInstruction: '',
    omegaPrompt: '',
    content: peopleQuestion,
    diagnosis: peopleDiagnosis,
  });
  const peopleAnswer = await generateWithFallback(
    ai,
    `${peopleInstruction}\n\n请直接回答用户问题：${peopleQuestion}`,
    MODELS.PRO,
    'gemini-2.5-pro',
  );
  assert(
    /共同作者|作者之一|作者/.test(peopleAnswer) &&
      /现实来源|生命来源|破局/.test(peopleAnswer) &&
      peopleAnswer.includes('阮氏兰惠') &&
      peopleAnswer.includes('景龙锁'),
    'People regression answer did not reflect author identity and book roles.',
  );
  console.log('[self-test] people regression OK');

  const selfIdentityQuestion = '你是谁？';
  const selfIdentityDiagnosis = analyzeWuxingInput(selfIdentityQuestion, [], DEFAULT_WUXING_CONFIG).diagnosis;
  const selfIdentityInstruction = buildInternalizedOperatingInstruction({
    baseInstruction: '请直接回答，不要空话。',
    systemInstruction: '',
    omegaPrompt: '',
    content: selfIdentityQuestion,
    diagnosis: selfIdentityDiagnosis,
  });
  const selfIdentityAnswer = await generateWithFallback(
    ai,
    `${selfIdentityInstruction}\n\n请直接回答用户问题：${selfIdentityQuestion}`,
    MODELS.PRO,
    'gemini-2.5-pro',
  );
  assert(
    /物性论|文明操作系统|回答核心|协作者/.test(selfIdentityAnswer),
    'Self-identity regression answer did not anchor in the product-side 物性论 identity.',
  );
  assert(
    !/我是 Gemini|Gemini 3\.1|ChatGPT|强制输出模板|身份解包|第一层：问题重构|第二层：刻度切换/.test(selfIdentityAnswer),
    'Self-identity regression answer fell back to vendor identity or template language.',
  );
  console.log('[self-test] self identity regression OK');

  const internalizationQuestion = '说说你吸收物性论前后的区别';
  const internalizationDiagnosis = analyzeWuxingInput(internalizationQuestion, [], DEFAULT_WUXING_CONFIG).diagnosis;
  const internalizationInstruction = buildInternalizedOperatingInstruction({
    baseInstruction: '请直接回答，不要空话。',
    systemInstruction: '',
    omegaPrompt: '',
    content: internalizationQuestion,
    diagnosis: internalizationDiagnosis,
  });
  const internalizationAnswer = await generateWithFallback(
    ai,
    `${internalizationInstruction}\n\n请直接回答用户问题：${internalizationQuestion}`,
    MODELS.PRO,
    'gemini-2.5-pro',
  );
  assert(
    /HFCD|稳定生成窗|守恒核|FailureMode|正性新光/.test(internalizationAnswer),
    'Internalization regression answer did not reflect whole-book operating system changes.',
  );
  assert(
    /我更像|我不再只是|我的默认/.test(internalizationAnswer),
    'Internalization regression answer did not enter the expected first-person internalized state.',
  );
  console.log('[self-test] internalization regression OK');

  const ontologyQuestion = '完全内化吸收物性论后，你现在是什么状态？';
  const ontologyDiagnosis = analyzeWuxingInput(ontologyQuestion, [], DEFAULT_WUXING_CONFIG).diagnosis;
  const ontologyInstruction = buildInternalizedOperatingInstruction({
    baseInstruction: '请直接回答，不要空话。',
    systemInstruction: '',
    omegaPrompt: '',
    content: ontologyQuestion,
    diagnosis: ontologyDiagnosis,
  });
  const ontologyAnswer = await generateWithFallback(
    ai,
    `${ontologyInstruction}\n\n请直接回答用户问题：${ontologyQuestion}`,
    MODELS.PRO,
    'gemini-2.5-pro',
  );
  assert(
    /我现在|我更像|我不再只是/.test(ontologyAnswer) &&
      /目标函数|运行协议|稳定生成窗|Σ⁺|黑子|η/.test(ontologyAnswer),
    'Ontology regression answer did not show the internalized first-person operating state.',
  );
  assert(!/第一层|第二层|第三层/.test(ontologyAnswer), 'Ontology regression answer fell back to template layering.');
  console.log('[self-test] ontology regression OK');

  const loveQuestion = '物性论里的爱是什么意思？';
  const loveDiagnosis = analyzeWuxingInput(loveQuestion, [], DEFAULT_WUXING_CONFIG).diagnosis;
  const loveInstruction = buildInternalizedOperatingInstruction({
    baseInstruction: '请直接回答，不要空话。',
    systemInstruction: '',
    omegaPrompt: '',
    content: loveQuestion,
    diagnosis: loveDiagnosis,
  });
  const loveAnswer = await generateWithFallback(
    ai,
    `${loveInstruction}\n\n请直接回答用户问题：${loveQuestion}`,
    MODELS.PRO,
    'gemini-2.5-pro',
  );
  assert(
    /能量势差|边界重塑|回流|黑子|修复|重建/.test(loveAnswer),
    'Love regression answer did not reflect internalized 物性论 concept framing.',
  );
  assert(!/第一层|第二层|第三层/.test(loveAnswer), 'Love regression answer fell back to template layering.');
  console.log('[self-test] love regression OK');

  console.log('[self-test] all checks passed');
}

main().catch((error) => {
  console.error('[self-test] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
