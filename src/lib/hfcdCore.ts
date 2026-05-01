export type HFCDIndustry = 'quantum' | 'materials' | 'energy' | 'bio';

export type HFCDFailureMode =
  | 'stable'
  | 'Q_loss'
  | 'radius_induced_Q_loss'
  | 'manifest_underthreshold'
  | 'cavity_underfill'
  | 'core_decay'
  | 'de_localized'
  | 'high_peak_radius_outlier'
  | 'energy_surplus_overflow'
  | 'ultra_micro_energy_surplus'
  | 'buffer_decay'
  | 'unknown_boundary';

export interface HFCDGates {
  Q_error: number;
  energy_drift_per_q: number;
  cavity_peak_ratio: number;
  peak_ratio: number;
  radius_ratio: number;
  manifest_fraction: number;
  buffer_score: number;
}

export interface HFCDGateStatus {
  Q_safe: boolean;
  E_safe: boolean;
  C_safe: boolean;
  P_safe: boolean;
  R_safe: boolean;
  M_safe: boolean;
  B_safe: boolean;
}

export interface HFCDAuditResult {
  sample_id: string;
  gates: HFCDGates;
  gate_status: HFCDGateStatus;
  strict_stable: boolean;
  loose_stable: boolean;
  failure_mode: HFCDFailureMode;
  risk_score: number;
  repair_plan: string;
  readable: HFCDReadableDiagnosis;
  actual_failure?: number | null;
  baseline_score?: number | null;
  warning_lead_time?: number | null;
}

export interface HFCDTemplateField {
  key: string;
  label: string;
  required: boolean;
  description: string;
  unit?: string;
  direction?: 'higher_is_better' | 'lower_is_better' | 'label' | 'neutral';
  goodRange?: string;
  riskSignal?: string;
  hfcdGate?: keyof HFCDGates | 'blind_label' | 'identity';
  plainMeaning?: string;
}

export interface HFCDIndustrySpec {
  id: HFCDIndustry;
  title: string;
  shortTitle: string;
  description: string;
  templateFileName: string;
  fields: HFCDTemplateField[];
  sampleRows: Record<string, string | number>[];
}

export interface HFCDValidationSummary {
  sampleCount: number;
  hasActualFailure: boolean;
  auc: number | null;
  precisionTop10: number | null;
  baselineAuc?: number | null;
  baselinePrecisionTop10?: number | null;
  precisionLift?: number | null;
  warningLeadTimeAvg?: number | null;
  highRiskCount: number;
  failureRateTop10: number | null;
}

export interface HFCDAuditSummary {
  sampleCount: number;
  strictStableCount: number;
  looseStableCount: number;
  highRiskCount: number;
  primaryFailureMode: HFCDFailureMode | 'none';
  failureModeCounts: Record<string, number>;
  averageRiskScore: number;
}

export interface HFCDFieldHealth {
  key: string;
  label: string;
  present: boolean;
  required: boolean;
  hfcdGate?: HFCDTemplateField['hfcdGate'];
  effect: string;
  guidance: string;
}

export interface HFCDReadableDiagnosis {
  severity: '稳定' | '临界' | '高风险';
  businessSummary: string;
  hfcdSummary: string;
  repairSummary: string;
  failedGates: string[];
  primaryDrivers: string[];
}

export interface HFCDGateSafetySummary {
  gate: keyof HFCDGates;
  label: string;
  safeCount: number;
  failCount: number;
  safeRate: number;
}

export interface HFCDGateStats {
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
  mean: number;
}

export interface HFCDParameterProfile {
  id: string;
  industry: HFCDIndustry;
  sampleCount: number;
  labeledCount: number;
  stableLabelCount: number;
  failureLabelCount: number;
  generatedAt: number;
  thresholds: HFCDGates;
  baselineThresholds: HFCDGates;
  gateStats: Record<keyof HFCDGates, HFCDGateStats>;
  learnedFrom: 'actual_failure_0' | 'baseline_stable' | 'all_samples' | 'empty';
  recommendedUse: string;
  warnings: string[];
}

export type HFCDSimulationScenarioId =
  | 'baseline'
  | 'core_recenter'
  | 'load_trim'
  | 'support_upgrade'
  | 'risk_relocalize'
  | 'buffer_restore'
  | 'delivery_stabilize';

export interface HFCDSimulationScenario {
  id: HFCDSimulationScenarioId;
  name: string;
  shortName: string;
  description: string;
  target: string;
  multipliers: Partial<Record<keyof HFCDGates, number>>;
  offsets?: Partial<Record<keyof HFCDGates, number>>;
}

export interface HFCDSimulationScenarioResult {
  scenario: HFCDSimulationScenario;
  summary: HFCDAuditSummary;
  results: HFCDAuditResult[];
  strictStableGain: number;
  highRiskReduction: number;
  averageRiskScoreDelta: number;
  improvementScore: number;
}

export interface HFCDSimulationReport {
  industry: HFCDIndustry;
  generatedAt: number;
  profile: HFCDParameterProfile;
  baselineSummary: HFCDAuditSummary;
  scenarios: HFCDSimulationScenarioResult[];
  recommendedScenarioId: HFCDSimulationScenarioId;
}

export interface HFCDFieldSimulationInput {
  physical?: {
    qIdentityRigidity?: number;
    coherenceRetention?: number;
    fieldCoupling?: number;
    thermalLoad?: number;
    entropyPressure?: number;
  };
  process?: {
    controlGain?: number;
    processDrift?: number;
    repairIntensity?: number;
    measurementNoise?: number;
    materialSupport?: number;
  };
  boundary?: {
    boundaryTightness?: number;
    externalShock?: number;
    safetyReserve?: number;
    timeHorizon?: number;
    gridResolution?: number;
  };
  digitalTwin?: {
    coverage?: number;
    fidelity?: number;
    parameterCompleteness?: number;
    historicalDepth?: number;
  };
  scan?: {
    candidateCount?: number;
    scanDepth?: number;
    stepSize?: number;
  };
}

export interface HFCDNormalizedFieldSimulationInput {
  physical: Required<NonNullable<HFCDFieldSimulationInput['physical']>>;
  process: Required<NonNullable<HFCDFieldSimulationInput['process']>>;
  boundary: Required<NonNullable<HFCDFieldSimulationInput['boundary']>>;
  digitalTwin: Required<NonNullable<HFCDFieldSimulationInput['digitalTwin']>>;
  scan: Required<NonNullable<HFCDFieldSimulationInput['scan']>>;
}

export interface HFCDFieldTrajectoryPoint {
  step: number;
  strictStableCount: number;
  looseStableCount: number;
  highRiskCount: number;
  averageRiskScore: number;
  stabilityIndex: number;
  energyClosure: number;
}

export interface HFCDFieldCandidateResult {
  scenarioId: HFCDSimulationScenarioId;
  name: string;
  target: string;
  summary: HFCDAuditSummary;
  results: HFCDAuditResult[];
  trajectory: HFCDFieldTrajectoryPoint[];
  stabilityIndex: number;
  energyClosure: number;
  convergenceScore: number;
  predictedGain: number;
  confidence: number;
}

export interface HFCDFieldSimulationReport {
  model: 'hfcd-field-v1';
  industry: HFCDIndustry;
  generatedAt: number;
  input: HFCDNormalizedFieldSimulationInput;
  requirements: string[];
  profile: HFCDParameterProfile;
  baselineSummary: HFCDAuditSummary;
  candidates: HFCDFieldCandidateResult[];
  recommendedCandidateId: HFCDSimulationScenarioId;
}

export const HFCD_THRESHOLDS: HFCDGates = {
  Q_error: 0.01,
  energy_drift_per_q: 0.05,
  cavity_peak_ratio: 0.85,
  peak_ratio: 1.0,
  radius_ratio: 1.3,
  manifest_fraction: 0.8,
  buffer_score: 0.5,
};

const HFCD_GATE_KEYS = [
  'Q_error',
  'energy_drift_per_q',
  'cavity_peak_ratio',
  'peak_ratio',
  'radius_ratio',
  'manifest_fraction',
  'buffer_score',
] as const;

const HFCD_UPPER_LIMIT_GATES = new Set<keyof HFCDGates>(['Q_error', 'energy_drift_per_q', 'radius_ratio']);

const HFCD_THRESHOLD_LIMITS: Record<keyof HFCDGates, [number, number]> = {
  Q_error: [0.004, 0.03],
  energy_drift_per_q: [0.02, 0.09],
  cavity_peak_ratio: [0.65, 1.05],
  peak_ratio: [0.72, 1.16],
  radius_ratio: [1.05, 1.6],
  manifest_fraction: [0.55, 0.98],
  buffer_score: [0.25, 0.95],
};

export const HFCD_SIMULATION_SCENARIOS: HFCDSimulationScenario[] = [
  {
    id: 'baseline',
    name: '当前方案',
    shortName: '当前',
    description: '不改变参数，用当前数据作为对照组。',
    target: '对照当前风险面',
    multipliers: {},
  },
  {
    id: 'core_recenter',
    name: '核心状态回中',
    shortName: '回中',
    description: '优先修复核心状态漂移，让芯片相干、材料相身份、电芯 SOH 或细胞身份回到稳定区。',
    target: '降低核心状态误差，保护关键性能',
    multipliers: { Q_error: 0.72, peak_ratio: 1.025, buffer_score: 1.04 },
  },
  {
    id: 'load_trim',
    name: '运行负荷收敛',
    shortName: '降负荷',
    description: '收敛过驱动、过热、过载或代谢负担，减少系统内部消化不了的负荷。',
    target: '降低运行负荷漂移，避免过载型失稳',
    multipliers: { energy_drift_per_q: 0.68, peak_ratio: 0.99, buffer_score: 1.06 },
  },
  {
    id: 'support_upgrade',
    name: '支撑条件增强',
    shortName: '强支撑',
    description: '增强读出、微结构、界面或培养环境，让关键输出被稳定承接。',
    target: '提高支撑条件和交付达标率',
    multipliers: { cavity_peak_ratio: 1.09, manifest_fraction: 1.05, buffer_score: 1.04 },
  },
  {
    id: 'risk_relocalize',
    name: '风险范围收窄',
    shortName: '收风险',
    description: '压回串扰、裂纹、退化扩散或异质性外溢，先阻止风险从局部扩散到全局。',
    target: '降低风险扩散范围，恢复局部可控性',
    multipliers: { radius_ratio: 0.84, Q_error: 0.9, buffer_score: 1.08 },
  },
  {
    id: 'buffer_restore',
    name: '安全余量恢复',
    shortName: '补余量',
    description: '恢复校准、工艺、热管理、压力恢复等余量，增强抗扰动能力。',
    target: '提高安全余量，降低临界样本被扰动击穿的概率',
    multipliers: { buffer_score: 1.24, energy_drift_per_q: 0.9, manifest_fraction: 1.025 },
  },
  {
    id: 'delivery_stabilize',
    name: '交付达标稳定',
    shortName: '稳交付',
    description: '优先提升任务成功率、性能保持、库伦效率或 CQA 达标比例。',
    target: '提升真实交付比例，不只优化单个实验指标',
    multipliers: { manifest_fraction: 1.12, peak_ratio: 1.04, cavity_peak_ratio: 1.03 },
  },
];

const HFCD_FIELD_DEFAULTS: Record<HFCDIndustry, HFCDNormalizedFieldSimulationInput> = {
  quantum: {
    physical: { qIdentityRigidity: 0.72, coherenceRetention: 0.74, fieldCoupling: 0.68, thermalLoad: 0.34, entropyPressure: 0.28 },
    process: { controlGain: 0.7, processDrift: 0.24, repairIntensity: 0.66, measurementNoise: 0.26, materialSupport: 0.7 },
    boundary: { boundaryTightness: 0.68, externalShock: 0.22, safetyReserve: 0.64, timeHorizon: 180, gridResolution: 48 },
    digitalTwin: { coverage: 0.66, fidelity: 0.68, parameterCompleteness: 0.62, historicalDepth: 0.56 },
    scan: { candidateCount: 6, scanDepth: 0.72, stepSize: 0.08 },
  },
  materials: {
    physical: { qIdentityRigidity: 0.7, coherenceRetention: 0.69, fieldCoupling: 0.64, thermalLoad: 0.42, entropyPressure: 0.32 },
    process: { controlGain: 0.62, processDrift: 0.28, repairIntensity: 0.64, measurementNoise: 0.2, materialSupport: 0.78 },
    boundary: { boundaryTightness: 0.66, externalShock: 0.26, safetyReserve: 0.62, timeHorizon: 220, gridResolution: 44 },
    digitalTwin: { coverage: 0.6, fidelity: 0.62, parameterCompleteness: 0.58, historicalDepth: 0.54 },
    scan: { candidateCount: 6, scanDepth: 0.68, stepSize: 0.08 },
  },
  energy: {
    physical: { qIdentityRigidity: 0.68, coherenceRetention: 0.7, fieldCoupling: 0.66, thermalLoad: 0.46, entropyPressure: 0.35 },
    process: { controlGain: 0.66, processDrift: 0.32, repairIntensity: 0.62, measurementNoise: 0.22, materialSupport: 0.72 },
    boundary: { boundaryTightness: 0.7, externalShock: 0.3, safetyReserve: 0.66, timeHorizon: 240, gridResolution: 52 },
    digitalTwin: { coverage: 0.64, fidelity: 0.65, parameterCompleteness: 0.6, historicalDepth: 0.58 },
    scan: { candidateCount: 6, scanDepth: 0.7, stepSize: 0.08 },
  },
  bio: {
    physical: { qIdentityRigidity: 0.66, coherenceRetention: 0.68, fieldCoupling: 0.62, thermalLoad: 0.38, entropyPressure: 0.42 },
    process: { controlGain: 0.6, processDrift: 0.34, repairIntensity: 0.58, measurementNoise: 0.28, materialSupport: 0.74 },
    boundary: { boundaryTightness: 0.62, externalShock: 0.3, safetyReserve: 0.58, timeHorizon: 200, gridResolution: 40 },
    digitalTwin: { coverage: 0.58, fidelity: 0.6, parameterCompleteness: 0.56, historicalDepth: 0.5 },
    scan: { candidateCount: 6, scanDepth: 0.64, stepSize: 0.08 },
  },
};

export const HFCD_GATE_EXPLANATIONS: Record<
  keyof HFCDGates,
  { label: string; businessMeaning: string; safeRule: string }
> = {
  Q_error: {
    label: '核心状态误差',
    businessMeaning: '关键对象是否保持稳定。量子芯片对应相干状态，新材料对应目标相，电池对应 SOH，生命科学对应细胞身份。',
    safeRule: '误差不高于 0.01',
  },
  energy_drift_per_q: {
    label: '运行负荷漂移',
    businessMeaning: '系统是否出现过驱动、过热、过载或输入输出不匹配。',
    safeRule: '漂移不高于 0.05',
  },
  cavity_peak_ratio: {
    label: '支撑条件充足度',
    businessMeaning: '环境、结构或工艺条件是否足以支撑关键输出。支撑不足时，系统看似还能运行，但可靠性会快速下降。',
    safeRule: '充足度不低于 0.85',
  },
  peak_ratio: {
    label: '关键性能保持',
    businessMeaning: '关键性能是否仍保持在可交付水平，不只是还能运行，而是还能稳定输出。',
    safeRule: '保持率不低于 1.00',
  },
  radius_ratio: {
    label: '风险扩散范围',
    businessMeaning: '风险是否从局部扩散到系统层面。数值越大，说明串扰、裂纹、退化或异质性正在外扩。',
    safeRule: '扩散范围不高于 1.30',
  },
  manifest_fraction: {
    label: '交付达标率',
    businessMeaning: '实验、生产或任务是否真正达标。它衡量系统从“看起来可行”到“实际交付”的比例。',
    safeRule: '达标率不低于 0.80',
  },
  buffer_score: {
    label: '安全余量',
    businessMeaning: '系统还有多少抗扰动空间。安全余量不足时，轻微扰动也可能触发失稳。',
    safeRule: '余量不低于 0.50',
  },
};

function clamp(value: unknown, lo: number, hi: number) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) return lo;
  return Math.max(lo, Math.min(hi, numberValue));
}

function safeNumber(row: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const value = row[key];
  if (value === null || value === undefined || value === '') return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizePositiveBad(value: number | undefined, good: number, bad: number): number | null {
  if (value === undefined) return null;
  if (value <= good) return 0;
  if (value >= bad) return 1;
  return (value - good) / (bad - good);
}

function firstFinite(values: Array<number | undefined>, fallback: number) {
  for (const value of values) {
    if (Number.isFinite(value)) return value as number;
  }
  return fallback;
}

function mean(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 6) {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

function percentile(values: number[], ratio: number) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function readActualFailure(row: Record<string, unknown>) {
  const value = safeNumber(row, 'actual_failure');
  if (value === 1) return 1;
  if (value === 0) return 0;
  return null;
}

function mergeThresholds(thresholds?: Partial<HFCDGates>): HFCDGates {
  const merged = { ...HFCD_THRESHOLDS, ...(thresholds || {}) };
  return HFCD_GATE_KEYS.reduce((next, gate) => {
    const [lo, hi] = HFCD_THRESHOLD_LIMITS[gate];
    next[gate] = round(clamp(merged[gate], lo, hi));
    return next;
  }, {} as HFCDGates);
}

export function normalizeHFCDThresholds(thresholds?: Partial<HFCDGates>) {
  return mergeThresholds(thresholds);
}

function calculateGateStats(gateSets: HFCDGates[]): Record<keyof HFCDGates, HFCDGateStats> {
  return HFCD_GATE_KEYS.reduce((stats, gate) => {
    const values = gateSets.map((gates) => gates[gate]).filter(Number.isFinite);
    stats[gate] = {
      min: round(values.length ? Math.min(...values) : 0),
      p25: round(percentile(values, 0.25)),
      median: round(percentile(values, 0.5)),
      p75: round(percentile(values, 0.75)),
      p90: round(percentile(values, 0.9)),
      max: round(values.length ? Math.max(...values) : 0),
      mean: round(mean(values)),
    };
    return stats;
  }, {} as Record<keyof HFCDGates, HFCDGateStats>);
}

function clampGateValue(gate: keyof HFCDGates, value: number) {
  const [lo, hi] = gate === 'radius_ratio' ? [0.9, 1.8] : gate === 'energy_drift_per_q' || gate === 'Q_error' ? [0, 0.12] : [0, 1.3];
  return round(clamp(value, lo, hi));
}

function normalizeUnit(value: number | undefined, fallback: number) {
  return round(clamp(value ?? fallback, 0, 1), 4);
}

function normalizeCount(value: number | undefined, fallback: number, lo: number, hi: number) {
  return Math.round(clamp(value ?? fallback, lo, hi));
}

export function defaultHFCDFieldSimulationInput(industry: HFCDIndustry): HFCDNormalizedFieldSimulationInput {
  return JSON.parse(JSON.stringify(HFCD_FIELD_DEFAULTS[industry])) as HFCDNormalizedFieldSimulationInput;
}

export function normalizeHFCDFieldSimulationInput(
  input: HFCDFieldSimulationInput | undefined,
  industry: HFCDIndustry,
): HFCDNormalizedFieldSimulationInput {
  const fallback = defaultHFCDFieldSimulationInput(industry);
  return {
    physical: {
      qIdentityRigidity: normalizeUnit(input?.physical?.qIdentityRigidity, fallback.physical.qIdentityRigidity),
      coherenceRetention: normalizeUnit(input?.physical?.coherenceRetention, fallback.physical.coherenceRetention),
      fieldCoupling: normalizeUnit(input?.physical?.fieldCoupling, fallback.physical.fieldCoupling),
      thermalLoad: normalizeUnit(input?.physical?.thermalLoad, fallback.physical.thermalLoad),
      entropyPressure: normalizeUnit(input?.physical?.entropyPressure, fallback.physical.entropyPressure),
    },
    process: {
      controlGain: normalizeUnit(input?.process?.controlGain, fallback.process.controlGain),
      processDrift: normalizeUnit(input?.process?.processDrift, fallback.process.processDrift),
      repairIntensity: normalizeUnit(input?.process?.repairIntensity, fallback.process.repairIntensity),
      measurementNoise: normalizeUnit(input?.process?.measurementNoise, fallback.process.measurementNoise),
      materialSupport: normalizeUnit(input?.process?.materialSupport, fallback.process.materialSupport),
    },
    boundary: {
      boundaryTightness: normalizeUnit(input?.boundary?.boundaryTightness, fallback.boundary.boundaryTightness),
      externalShock: normalizeUnit(input?.boundary?.externalShock, fallback.boundary.externalShock),
      safetyReserve: normalizeUnit(input?.boundary?.safetyReserve, fallback.boundary.safetyReserve),
      timeHorizon: normalizeCount(input?.boundary?.timeHorizon, fallback.boundary.timeHorizon, 24, 720),
      gridResolution: normalizeCount(input?.boundary?.gridResolution, fallback.boundary.gridResolution, 16, 128),
    },
    digitalTwin: {
      coverage: normalizeUnit(input?.digitalTwin?.coverage, fallback.digitalTwin.coverage),
      fidelity: normalizeUnit(input?.digitalTwin?.fidelity, fallback.digitalTwin.fidelity),
      parameterCompleteness: normalizeUnit(input?.digitalTwin?.parameterCompleteness, fallback.digitalTwin.parameterCompleteness),
      historicalDepth: normalizeUnit(input?.digitalTwin?.historicalDepth, fallback.digitalTwin.historicalDepth),
    },
    scan: {
      candidateCount: normalizeCount(input?.scan?.candidateCount, fallback.scan.candidateCount, 2, HFCD_SIMULATION_SCENARIOS.length),
      scanDepth: normalizeUnit(input?.scan?.scanDepth, fallback.scan.scanDepth),
      stepSize: round(clamp(input?.scan?.stepSize ?? fallback.scan.stepSize, 0.02, 0.24), 4),
    },
  };
}

export const HFCD_INDUSTRIES: Record<HFCDIndustry, HFCDIndustrySpec> = {
  quantum: {
    id: 'quantum',
    title: '量子芯片',
    shortTitle: 'Quantum Chip',
    description: '面向 QPU 校准窗口、门错误率、读出漂移、泄漏率与串扰的稳定窗审计。',
    templateFileName: 'hfcd_quantum_template.csv',
    fields: [
      { key: 'sample_id', label: '样本 ID', required: true, description: '校准窗口或样本 ID。' },
      { key: 'T1_us', label: 'T1', required: false, description: 'T1 相干时间，单位微秒。' },
      { key: 'T2_us', label: 'T2', required: false, description: 'T2 相干时间，单位微秒。' },
      { key: 'T2star_us', label: 'T2*', required: false, description: 'T2* 相干时间，单位微秒。' },
      { key: 'T1_ref_us', label: 'T1 参考', required: false, description: '参考 T1，用于计算 Q identity 漂移。' },
      { key: 'T2_ref_us', label: 'T2 参考', required: false, description: '参考 T2，用于计算 Q identity 漂移。' },
      { key: 'ramsey_detuning_khz', label: 'Ramsey detuning', required: false, description: 'Ramsey 失谐，单位 kHz。' },
      { key: 'gate1q_error', label: '单比特门错误率', required: false, description: '1Q gate error。' },
      { key: 'gate2q_error', label: '双比特门错误率', required: false, description: '2Q gate error。' },
      { key: 'readout_error', label: '读出错误率', required: false, description: 'Readout error。' },
      { key: 'assignment_fidelity', label: 'Assignment fidelity', required: false, description: '读出 assignment fidelity。' },
      { key: 'leakage_rate', label: '泄漏率', required: false, description: 'Leakage rate。' },
      { key: 'zz_crosstalk_khz', label: 'ZZ 串扰', required: false, description: 'ZZ crosstalk，单位 kHz。' },
      { key: 'parallel_gate_error', label: '并行门错误率', required: false, description: 'Parallel gate error。' },
      { key: 'resonator_drift_mhz', label: '谐振腔漂移', required: false, description: '读出谐振腔漂移，单位 MHz。' },
      { key: 'calibration_age_hours', label: '校准年龄', required: false, description: '距离上次校准的小时数。' },
      { key: 'job_success_rate', label: '任务成功率', required: false, description: '任务成功率，0 到 1。' },
      { key: 'actual_failure', label: '真实失效标签', required: false, description: '盲测标签，0/1。' },
    ],
    sampleRows: [
      {
        sample_id: 'qpu_cal_001',
        T1_us: 82,
        T2_us: 71,
        T2star_us: 62,
        T1_ref_us: 88,
        T2_ref_us: 76,
        ramsey_detuning_khz: 120,
        gate1q_error: 0.0007,
        gate2q_error: 0.009,
        readout_error: 0.025,
        assignment_fidelity: 0.94,
        leakage_rate: 0.002,
        zz_crosstalk_khz: 80,
        parallel_gate_error: 0.016,
        resonator_drift_mhz: 0.8,
        calibration_age_hours: 8,
        job_success_rate: 0.94,
        actual_failure: 0,
      },
    ],
  },
  materials: {
    id: 'materials',
    title: '新材料',
    shortTitle: 'Advanced Materials',
    description: '面向相纯度、缺陷、裂纹、应力、微结构承载和工艺余量的稳定窗审计。',
    templateFileName: 'hfcd_materials_template.csv',
    fields: [
      { key: 'sample_id', label: '样本 ID', required: true, description: '材料批次或样本 ID。' },
      { key: 'phase_purity', label: '相纯度', required: false, description: '目标相纯度，0 到 1。' },
      { key: 'defect_density_norm', label: '缺陷密度', required: false, description: '归一化缺陷密度，0 到 1。' },
      { key: 'crack_length_norm', label: '裂纹长度', required: false, description: '归一化裂纹长度，0 到 1。' },
      { key: 'stress_norm', label: '应力水平', required: false, description: '热/机械应力，0 到 1。' },
      { key: 'microstructure_support', label: '微结构承载', required: false, description: '微结构承载支持度，0 到 1。' },
      { key: 'property_retention', label: '性能保持率', required: false, description: '性能保持率，0 到 1。' },
      { key: 'process_margin', label: '工艺余量', required: false, description: '工艺余量，0 到 1。' },
      { key: 'actual_failure', label: '真实失效标签', required: false, description: '盲测标签，0/1。' },
    ],
    sampleRows: [
      {
        sample_id: 'mat_batch_001',
        phase_purity: 0.96,
        defect_density_norm: 0.12,
        crack_length_norm: 0.04,
        stress_norm: 0.28,
        microstructure_support: 0.91,
        property_retention: 0.94,
        process_margin: 0.76,
        actual_failure: 0,
      },
    ],
  },
  energy: {
    id: 'energy',
    title: '新能源',
    shortTitle: 'New Energy',
    description: '面向电芯 SOH、阻抗增长、热风险、界面稳定、退化扩散和安全余量的稳定窗审计。',
    templateFileName: 'hfcd_energy_template.csv',
    fields: [
      { key: 'sample_id', label: '样本 ID', required: true, description: '电芯、模组或设备 ID。' },
      { key: 'SOH', label: 'SOH', required: false, description: '健康状态，0 到 1。' },
      { key: 'capacity_retention', label: '容量保持率', required: false, description: '容量保持率，0 到 1。' },
      { key: 'impedance_growth_norm', label: '阻抗增长', required: false, description: '归一化阻抗增长，0 到 1。' },
      { key: 'thermal_risk_norm', label: '热风险', required: false, description: '归一化热风险，0 到 1。' },
      { key: 'coulombic_efficiency', label: '库伦效率', required: false, description: '库伦效率，0 到 1。' },
      { key: 'interface_stability', label: '界面稳定度', required: false, description: '界面稳定度，0 到 1。' },
      { key: 'degradation_spread_norm', label: '退化扩散', required: false, description: '退化扩散程度，0 到 1。' },
      { key: 'reserve_margin', label: '安全余量', required: false, description: '安全余量，0 到 1。' },
      { key: 'actual_failure', label: '真实失效标签', required: false, description: '盲测标签，0/1。' },
    ],
    sampleRows: [
      {
        sample_id: 'cell_001',
        SOH: 0.93,
        capacity_retention: 0.92,
        impedance_growth_norm: 0.18,
        thermal_risk_norm: 0.16,
        coulombic_efficiency: 0.996,
        interface_stability: 0.9,
        degradation_spread_norm: 0.14,
        reserve_margin: 0.72,
        actual_failure: 0,
      },
    ],
  },
  bio: {
    id: 'bio',
    title: '生命科学',
    shortTitle: 'Life Science',
    description: '面向细胞身份、活率、产量保持、代谢负载、异质性和 CQA 的稳定窗审计。',
    templateFileName: 'hfcd_bio_template.csv',
    fields: [
      { key: 'sample_id', label: '样本 ID', required: true, description: '批次、反应器或样本 ID。' },
      { key: 'cell_identity', label: '细胞身份', required: false, description: '细胞身份保持度，0 到 1。' },
      { key: 'viability', label: '活率', required: false, description: '细胞活率，0 到 1。' },
      { key: 'productivity_retention', label: '产量保持率', required: false, description: '产量保持率，0 到 1。' },
      { key: 'metabolic_load_norm', label: '代谢负载', required: false, description: '归一化代谢负载，0 到 1。' },
      { key: 'heterogeneity_norm', label: '异质性扩散', required: false, description: '归一化异质性扩散，0 到 1。' },
      { key: 'culture_support', label: '培养支持', required: false, description: '培养环境支持度，0 到 1。' },
      { key: 'stress_reserve', label: '压力恢复余量', required: false, description: '压力恢复余量，0 到 1。' },
      { key: 'CQA_pass_fraction', label: 'CQA 达标比例', required: false, description: '关键质量属性达标比例，0 到 1。' },
      { key: 'actual_failure', label: '真实失效标签', required: false, description: '盲测标签，0/1。' },
    ],
    sampleRows: [
      {
        sample_id: 'bio_batch_001',
        cell_identity: 0.95,
        viability: 0.94,
        productivity_retention: 0.9,
        metabolic_load_norm: 0.22,
        heterogeneity_norm: 0.12,
        culture_support: 0.91,
        stress_reserve: 0.73,
        CQA_pass_fraction: 0.93,
        actual_failure: 0,
      },
    ],
  },
};

const FIELD_PROFILES: Record<HFCDIndustry, Record<string, Partial<HFCDTemplateField>>> = {
  quantum: {
    sample_id: {
      unit: '-',
      direction: 'label',
      hfcdGate: 'identity',
      plainMeaning: '一次校准窗口、实验批次或芯片样本编号，用来追踪每条诊断结果。',
      goodRange: '唯一且不为空',
      riskSignal: '编号缺失会导致报告无法定位风险样本。',
    },
    T1_us: {
      unit: 'us',
      direction: 'higher_is_better',
      hfcdGate: 'Q_error',
      plainMeaning: '量子比特从激发态回落前能保持多久，是判断核心相干状态是否稳定的关键指标。',
      goodRange: '越接近或高于 T1_ref_us 越好',
      riskSignal: 'T1 明显低于参考值会推高核心状态误差，表示相干能力退化。',
    },
    T2_us: {
      unit: 'us',
      direction: 'higher_is_better',
      hfcdGate: 'Q_error',
      plainMeaning: '相位相干能保持多久，直接反映芯片核心身份是否被噪声侵蚀。',
      goodRange: '越接近或高于 T2_ref_us 越好',
      riskSignal: 'T2 下滑会推高 Q_error，常见于退相干、串扰或环境噪声上升。',
    },
    T2star_us: {
      unit: 'us',
      direction: 'higher_is_better',
      hfcdGate: 'Q_error',
      plainMeaning: '未回波校正下的相干时间，帮助识别慢漂移和频率噪声。',
      goodRange: '越高越好',
      riskSignal: 'T2* 过低通常说明频率环境不干净，需要补充 detuning 和串扰检查。',
    },
    T1_ref_us: {
      unit: 'us',
      direction: 'neutral',
      hfcdGate: 'Q_error',
      plainMeaning: 'T1 的基准线，用来判断当前窗口相对历史好状态退化了多少。',
      goodRange: '使用同芯片或同批次可信基准',
      riskSignal: '参考值缺失时，Q_error 会退回保守估计，诊断分辨率下降。',
    },
    T2_ref_us: {
      unit: 'us',
      direction: 'neutral',
      hfcdGate: 'Q_error',
      plainMeaning: 'T2 的基准线，用来判断相干身份的相对漂移。',
      goodRange: '使用同芯片或同批次可信基准',
      riskSignal: '参考值缺失会降低核心状态漂移判断精度。',
    },
    ramsey_detuning_khz: {
      unit: 'kHz',
      direction: 'lower_is_better',
      hfcdGate: 'radius_ratio',
      plainMeaning: 'Ramsey 失谐越大，说明频率窗口越偏离中心，风险半径越容易外扩。',
      goodRange: '越接近 0 越好',
      riskSignal: '失谐过大会推高 radius_ratio，进入 de_localized 风险。',
    },
    gate1q_error: {
      unit: 'ratio',
      direction: 'lower_is_better',
      hfcdGate: 'energy_drift_per_q',
      plainMeaning: '单比特门错误率，反映基础控制脉冲是否干净。',
      goodRange: '<= 0.0005 为优秀区',
      riskSignal: '错误率上升会推高 energy_drift_per_q，并压低 peak_ratio。',
    },
    gate2q_error: {
      unit: 'ratio',
      direction: 'lower_is_better',
      hfcdGate: 'energy_drift_per_q',
      plainMeaning: '双比特门错误率，是量子芯片最敏感的核心性能窗口之一。',
      goodRange: '<= 0.005 为优秀区',
      riskSignal: '2Q error 上升会同时推高运行负荷漂移并压低关键性能。',
    },
    readout_error: {
      unit: 'ratio',
      direction: 'lower_is_better',
      hfcdGate: 'cavity_peak_ratio',
      plainMeaning: '读出错误率，反映测量链路是否能承载并识别核心状态。',
      goodRange: '<= 0.01 为优秀区',
      riskSignal: '读出错误上升会削弱支撑条件，并拖累最终达标率。',
    },
    assignment_fidelity: {
      unit: 'ratio',
      direction: 'higher_is_better',
      hfcdGate: 'cavity_peak_ratio',
      plainMeaning: '读出 assignment fidelity 越高，说明承载腔越能准确接住核心状态。',
      goodRange: '>= 0.95 更稳',
      riskSignal: 'fidelity 下滑会触发 cavity_underfill 风险。',
    },
    leakage_rate: {
      unit: 'ratio',
      direction: 'lower_is_better',
      hfcdGate: 'Q_error',
      plainMeaning: '泄漏率反映量子态是否逃出计算子空间，是核心相干状态破损的强信号。',
      goodRange: '<= 0.001 为优秀区',
      riskSignal: '泄漏上升会同时推高 Q_error 与 energy_drift_per_q。',
    },
    zz_crosstalk_khz: {
      unit: 'kHz',
      direction: 'lower_is_better',
      hfcdGate: 'radius_ratio',
      plainMeaning: 'ZZ 串扰越高，说明相邻比特之间的影响半径正在扩散。',
      goodRange: '越接近 0 越好',
      riskSignal: '串扰过高会推高 radius_ratio，触发 de_localized。',
    },
    parallel_gate_error: {
      unit: 'ratio',
      direction: 'lower_is_better',
      hfcdGate: 'energy_drift_per_q',
      plainMeaning: '并行门错误率反映多比特同时运行时是否出现系统级过载。',
      goodRange: '<= 0.01 更稳',
      riskSignal: '并行错误率上升通常说明 drive、串扰或调度窗口需要收敛。',
    },
    resonator_drift_mhz: {
      unit: 'MHz',
      direction: 'lower_is_better',
      hfcdGate: 'cavity_peak_ratio',
      plainMeaning: '读出谐振腔漂移，直接影响测量链路能否稳定接住核心状态。',
      goodRange: '越接近 0 越好',
      riskSignal: '漂移增大会削弱 cavity_peak_ratio，触发 cavity_underfill。',
    },
    calibration_age_hours: {
      unit: 'hours',
      direction: 'lower_is_better',
      hfcdGate: 'buffer_score',
      plainMeaning: '距离上次校准越久，系统安全余量越容易被消耗。',
      goodRange: '<= 24 小时较稳',
      riskSignal: '校准年龄过高会压低 buffer_score，进入 buffer_decay。',
    },
    job_success_rate: {
      unit: 'ratio',
      direction: 'higher_is_better',
      hfcdGate: 'manifest_fraction',
      plainMeaning: '任务成功率反映系统是否真正完成交付。',
      goodRange: '>= 0.80 为达标安全线',
      riskSignal: '成功率低于 0.80 会触发交付达标不足风险。',
    },
    actual_failure: {
      unit: '0/1',
      direction: 'label',
      hfcdGate: 'blind_label',
      plainMeaning: '历史真实失效标签，只用于盲测验证，不参与当前风险分调参。',
      goodRange: '0=未失效，1=已失效',
      riskSignal: '有这个字段才能计算 AUC 和 precision@top10%。',
    },
  },
  materials: {
    sample_id: { unit: '-', direction: 'label', hfcdGate: 'identity', plainMeaning: '材料批次或样本编号。', goodRange: '唯一且不为空', riskSignal: '缺失会导致风险样本不可追踪。' },
    phase_purity: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'Q_error', plainMeaning: '目标相纯度，决定材料核心相结构是否稳定。', goodRange: '>= 0.95 更稳', riskSignal: '相纯度下降会触发核心状态退化。' },
    defect_density_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'radius_ratio', plainMeaning: '缺陷密度，越高越容易让失效半径外扩。', goodRange: '<= 0.10 更稳', riskSignal: '缺陷扩散会触发 de_localized。' },
    crack_length_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'radius_ratio', plainMeaning: '裂纹长度，反映结构风险是否已经传播。', goodRange: '<= 0.10 更稳', riskSignal: '裂纹扩展会推高 radius_ratio。' },
    stress_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'energy_drift_per_q', plainMeaning: '热/机械应力，反映工艺是否过驱动。', goodRange: '<= 0.30 更稳', riskSignal: '应力过高会触发 energy_surplus_overflow。' },
    microstructure_support: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'cavity_peak_ratio', plainMeaning: '微结构承载支持度，决定性能峰值能不能被结构接住。', goodRange: '>= 0.85 更稳', riskSignal: '承载不足会触发 cavity_underfill。' },
    property_retention: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'peak_ratio', plainMeaning: '性能保持率，反映关键性能是否保住。', goodRange: '>= 0.90 更稳', riskSignal: '保持率下降会触发关键性能下滑或交付达标不足。' },
    process_margin: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'buffer_score', plainMeaning: '工艺余量，决定系统抗扰动能力。', goodRange: '>= 0.50 为安全线', riskSignal: '余量不足会触发 buffer_decay。' },
    actual_failure: { unit: '0/1', direction: 'label', hfcdGate: 'blind_label', plainMeaning: '历史真实失效标签，用于盲测验证。', goodRange: '0=未失效，1=已失效', riskSignal: '有标签才能证明 HFCD 是否提前预警。' },
  },
  energy: {
    sample_id: { unit: '-', direction: 'label', hfcdGate: 'identity', plainMeaning: '电芯、模组或设备编号。', goodRange: '唯一且不为空', riskSignal: '缺失会导致风险样本不可追踪。' },
    SOH: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'Q_error', plainMeaning: '健康状态，决定电芯身份是否还稳定。', goodRange: '>= 0.90 更稳', riskSignal: 'SOH 下滑会触发 Q_loss。' },
    capacity_retention: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'peak_ratio', plainMeaning: '容量保持率，反映核心输出能力是否还保住。', goodRange: '>= 0.90 更稳', riskSignal: '容量下降会压低 peak_ratio。' },
    impedance_growth_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'energy_drift_per_q', plainMeaning: '阻抗增长，反映能量通道是否变窄、发热是否增加。', goodRange: '<= 0.20 更稳', riskSignal: '阻抗增长会推高 energy_drift_per_q。' },
    thermal_risk_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'energy_drift_per_q', plainMeaning: '热风险，反映系统是否正在接近热失控边界。', goodRange: '<= 0.20 更稳', riskSignal: '热风险上升会触发 energy_surplus_overflow。' },
    coulombic_efficiency: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'manifest_fraction', plainMeaning: '库伦效率，反映充放电过程是否真正闭合。', goodRange: '>= 0.995 更稳', riskSignal: '效率下降会触发 manifest_underthreshold。' },
    interface_stability: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'cavity_peak_ratio', plainMeaning: '界面稳定度，决定能量交换界面能否承载循环。', goodRange: '>= 0.85 更稳', riskSignal: '界面失稳会触发 cavity_underfill。' },
    degradation_spread_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'radius_ratio', plainMeaning: '退化扩散程度，反映风险是否从局部扩散到整体。', goodRange: '<= 0.15 更稳', riskSignal: '扩散上升会触发 de_localized。' },
    reserve_margin: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'buffer_score', plainMeaning: '安全余量，决定系统还有多少抗扰动空间。', goodRange: '>= 0.50 为安全线', riskSignal: '余量下降会触发 buffer_decay。' },
    actual_failure: { unit: '0/1', direction: 'label', hfcdGate: 'blind_label', plainMeaning: '历史真实失效标签，用于盲测验证。', goodRange: '0=未失效，1=已失效', riskSignal: '有标签才能验证预测命中率。' },
  },
  bio: {
    sample_id: { unit: '-', direction: 'label', hfcdGate: 'identity', plainMeaning: '批次、反应器或样本编号。', goodRange: '唯一且不为空', riskSignal: '缺失会导致风险样本不可追踪。' },
    cell_identity: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'Q_error', plainMeaning: '细胞身份保持度，决定生物系统的核心细胞状态是否稳定。', goodRange: '>= 0.95 更稳', riskSignal: '身份漂移会触发核心状态退化。' },
    viability: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'peak_ratio', plainMeaning: '活率，反映系统还能不能维持有效输出。', goodRange: '>= 0.90 更稳', riskSignal: '活率下降会触发 core_decay。' },
    productivity_retention: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'peak_ratio', plainMeaning: '产量保持率，反映核心输出是否持续。', goodRange: '>= 0.90 更稳', riskSignal: '产量下滑会压低 peak_ratio 和 manifest_fraction。' },
    metabolic_load_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'energy_drift_per_q', plainMeaning: '代谢负载，反映系统是否被过度喂养或压力过高。', goodRange: '<= 0.25 更稳', riskSignal: '代谢负载过高会触发 energy_surplus_overflow。' },
    heterogeneity_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'radius_ratio', plainMeaning: '异质性扩散，反映细胞状态是否分叉外溢。', goodRange: '<= 0.15 更稳', riskSignal: '异质性上升会触发 de_localized。' },
    culture_support: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'cavity_peak_ratio', plainMeaning: '培养环境支持度，决定细胞系统能否被环境稳定承载。', goodRange: '>= 0.85 更稳', riskSignal: '培养支持不足会触发 cavity_underfill。' },
    stress_reserve: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'buffer_score', plainMeaning: '压力恢复余量，决定系统被扰动后能不能回到稳定窗。', goodRange: '>= 0.50 为安全线', riskSignal: '余量不足会触发 buffer_decay。' },
    CQA_pass_fraction: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'manifest_fraction', plainMeaning: '关键质量属性达标比例，反映最终质量是否真正达标。', goodRange: '>= 0.80 为安全线', riskSignal: 'CQA 不达标会触发交付达标不足。' },
    actual_failure: { unit: '0/1', direction: 'label', hfcdGate: 'blind_label', plainMeaning: '历史真实失效标签，用于盲测验证。', goodRange: '0=未失效，1=已失效', riskSignal: '有标签才能验证 HFCD 命中率。' },
  },
};

export function getFieldProfile(industry: HFCDIndustry, key: string): HFCDTemplateField {
  const base = HFCD_INDUSTRIES[industry].fields.find((field) => field.key === key) || {
    key,
    label: key,
    required: false,
    description: 'CSV 中的额外字段。',
  };
  return {
    ...base,
    ...(FIELD_PROFILES[industry][key] || {}),
  };
}

export function getIndustryFieldProfiles(industry: HFCDIndustry) {
  return HFCD_INDUSTRIES[industry].fields.map((field) => getFieldProfile(industry, field.key));
}

export const FAILURE_MODE_LABELS: Record<HFCDFailureMode, string> = {
  stable: '稳定',
  Q_loss: '核心状态退化',
  radius_induced_Q_loss: '扩散拖累核心状态',
  manifest_underthreshold: '交付达标不足',
  cavity_underfill: '支撑条件不足',
  core_decay: '关键性能下滑',
  de_localized: '风险外扩',
  high_peak_radius_outlier: '高输出外溢',
  energy_surplus_overflow: '运行负荷过载',
  ultra_micro_energy_surplus: '微小过载',
  buffer_decay: '安全余量不足',
  unknown_boundary: '未知边界',
};

export const BASE_REPAIR_PLANS: Record<HFCDFailureMode, string> = {
  stable: '保持当前参数窗口；进入下一轮复测、盲测确认或长周期跟踪。',
  Q_loss: '重新校准核心状态；优先保护关键身份指标，避免直接全局重调。',
  radius_induced_Q_loss: '优先收敛风险扩散范围，再复核核心状态指标。',
  manifest_underthreshold: '先恢复交付达标率或任务成功率，不盲目扩大其它参数。',
  cavity_underfill: '提升支撑条件或承载环境，避免单纯加大输入强度。',
  core_decay: '提升关键性能下限，同时限制过载和副作用风险。',
  de_localized: '对外扩风险做局部收敛，优先处理外层扩散、串扰、裂纹或异质性来源。',
  high_peak_radius_outlier: '限制高输出带来的外溢风险，在保持性能的同时收窄风险范围。',
  energy_surplus_overflow: '拆分负荷来源，执行小步收敛和过载控制，避免一次性大幅重调。',
  ultra_micro_energy_surplus: '只做微幅负荷修正；目标是压低小过载，同时保护已经达标的指标。',
  buffer_decay: '恢复安全余量，优先补足抗扰动空间，避免短期性能追求压垮系统。',
  unknown_boundary: '进行人工复核，并沉淀新的风险类型和处理规则。',
};

const INDUSTRY_APPENDIX: Record<HFCDIndustry, Partial<Record<HFCDFailureMode, string>>> = {
  quantum: {
    Q_loss: '重点检查 T1/T2/T2* 漂移、leakage、qubit identity 与 reset 质量。',
    energy_surplus_overflow: '重点检查 gate drive、parallel gate error、thermal excursion、leakage 与 readout error。',
    ultra_micro_energy_surplus: '只做微幅 pulse/drive 调整；避免重校准破坏已稳定窗口。',
    de_localized: '重点检查 ZZ crosstalk、frequency crowding、qubit routing 与 coupler avoid list。',
    cavity_underfill: '重点检查 readout resonator drift、SNR、assignment fidelity。',
  },
  materials: {
    Q_loss: '重点检查相身份、成分偏析和晶相转变。',
    energy_surplus_overflow: '重点检查热处理、应力窗口、相变能量与工艺过驱动。',
    de_localized: '重点检查缺陷扩散、裂纹扩展、晶粒边界与相界稳定。',
  },
  energy: {
    Q_loss: '重点检查 SOH 身份漂移、容量保持和不可逆损伤。',
    energy_surplus_overflow: '重点检查阻抗增长、热风险、倍率窗口和局部电化学过载。',
    de_localized: '重点检查退化扩散、局部热斑、极片不均匀和界面失稳。',
  },
  bio: {
    Q_loss: '重点检查 cell identity、marker expression、batch identity。',
    energy_surplus_overflow: '重点检查代谢负载、底物过量、pH/DO/温度压力和代谢废物积累。',
    de_localized: '重点检查异质性扩散、亚群漂移、细胞状态分叉。',
    cavity_underfill: '重点检查培养环境、反应器支持、营养与气体交换。',
  },
};

export function parseCsv(csv: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === ',' && !quoted) {
      row.push(field.trim());
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(field.trim());
      field = '';
      if (row.some((item) => item.length > 0)) rows.push(row);
      row = [];
      continue;
    }

    field += char;
  }

  row.push(field.trim());
  if (row.some((item) => item.length > 0)) rows.push(row);
  if (rows.length === 0) return [];

  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = values[index] || '';
    });
    return record;
  });
}

export function toCsv(rows: Array<Record<string, unknown>>, headers?: string[]) {
  const csvHeaders =
    headers ||
    Array.from(
      rows.reduce((set, row) => {
        Object.keys(row).forEach((key) => set.add(key));
        return set;
      }, new Set<string>()),
    );

  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [csvHeaders.join(','), ...rows.map((row) => csvHeaders.map((header) => escape(row[header])).join(','))].join('\n');
}

export function templateToCsv(industry: HFCDIndustry) {
  const spec = HFCD_INDUSTRIES[industry];
  return toCsv(spec.sampleRows, spec.fields.map((field) => field.key));
}

function adaptQuantum(row: Record<string, unknown>): HFCDGates {
  const T1 = safeNumber(row, 'T1_us');
  const T2 = safeNumber(row, 'T2_us');
  const T1Ref = safeNumber(row, 'T1_ref_us', T1 || 1);
  const T2Ref = safeNumber(row, 'T2_ref_us', T2 || 1);
  const qLossRisks: number[] = [];

  if (T1 && T1Ref) qLossRisks.push(Math.max(0, 1 - T1 / Math.max(T1Ref, 1e-9)));
  if (T2 && T2Ref) qLossRisks.push(Math.max(0, 1 - T2 / Math.max(T2Ref, 1e-9)));

  const leakageRisk = normalizePositiveBad(safeNumber(row, 'leakage_rate'), 0.001, 0.02);
  if (leakageRisk !== null) qLossRisks.push(leakageRisk);
  const Q_error = qLossRisks.length ? Math.min(0.03, mean(qLossRisks) * 0.03) : 0.005;

  const energyRisks: number[] = [];
  [
    ['gate1q_error', 0.0005, 0.01],
    ['gate2q_error', 0.005, 0.05],
    ['RB_EPC', 0.005, 0.05],
    ['XEB_error', 0.005, 0.05],
    ['parallel_gate_error', 0.01, 0.08],
    ['readout_error', 0.01, 0.1],
    ['leakage_rate', 0.001, 0.02],
  ].forEach(([key, good, bad]) => {
    const risk = normalizePositiveBad(safeNumber(row, String(key)), Number(good), Number(bad));
    if (risk !== null) energyRisks.push(risk);
  });
  const energy_drift_per_q = energyRisks.length ? 0.025 + 0.045 * mean(energyRisks) : 0.04;

  const assignmentFidelity = safeNumber(row, 'assignment_fidelity');
  const readoutError = safeNumber(row, 'readout_error');
  const resonatorDrift = safeNumber(row, 'resonator_drift_mhz');
  let cavity = 0.9;
  if (assignmentFidelity !== undefined) cavity = 0.8 + 0.2 * clamp(assignmentFidelity, 0, 1);
  if (readoutError !== undefined) cavity -= 0.1 * clamp((readoutError - 0.02) / 0.1, 0, 1);
  if (resonatorDrift !== undefined) cavity -= 0.08 * clamp(Math.abs(resonatorDrift) / 5, 0, 1);

  const gate2qError = safeNumber(row, 'gate2q_error');
  const gate1qError = safeNumber(row, 'gate1q_error');
  let peakRatio = 1.08;
  if (gate2qError !== undefined) peakRatio -= 0.18 * clamp((gate2qError - 0.005) / 0.05, 0, 1);
  if (gate1qError !== undefined) peakRatio -= 0.08 * clamp((gate1qError - 0.0005) / 0.01, 0, 1);

  const zz = safeNumber(row, 'zz_crosstalk_khz');
  const detuning = safeNumber(row, 'ramsey_detuning_khz');
  let radiusRatio = 1.15;
  if (zz !== undefined) radiusRatio += 0.2 * clamp(Math.abs(zz) / 300, 0, 1);
  if (detuning !== undefined) radiusRatio += 0.15 * clamp(Math.abs(detuning) / 1000, 0, 1);

  const calibrationAge = safeNumber(row, 'calibration_age_hours');
  let bufferScore = 0.85;
  if (calibrationAge !== undefined) bufferScore -= 0.5 * clamp(calibrationAge / 72, 0, 1);

  return {
    Q_error: round(Q_error),
    energy_drift_per_q: round(energy_drift_per_q),
    cavity_peak_ratio: round(clamp(cavity, 0.7, 1.1)),
    peak_ratio: round(clamp(peakRatio, 0.7, 1.25)),
    radius_ratio: round(clamp(radiusRatio, 1, 1.6)),
    manifest_fraction: round(clamp(firstFinite([safeNumber(row, 'job_success_rate')], 0.95), 0, 1)),
    buffer_score: round(clamp(bufferScore, 0, 1)),
  };
}

function adaptMaterials(row: Record<string, unknown>): HFCDGates {
  const phasePurity = safeNumber(row, 'phase_purity', 0.95) as number;
  const defect = safeNumber(row, 'defect_density_norm', 0.1) as number;
  const crack = safeNumber(row, 'crack_length_norm', 0.1) as number;
  const stress = safeNumber(row, 'stress_norm', 0.3) as number;
  const support = safeNumber(row, 'microstructure_support', 0.9) as number;
  const retention = safeNumber(row, 'property_retention', 0.95) as number;
  const margin = safeNumber(row, 'process_margin', 0.8) as number;
  return {
    Q_error: round(0.03 * (1 - clamp(phasePurity, 0, 1))),
    energy_drift_per_q: round(0.02 + 0.06 * clamp(stress, 0, 1)),
    cavity_peak_ratio: round(0.75 + 0.25 * clamp(support, 0, 1)),
    peak_ratio: round(0.7 + 0.4 * clamp(retention, 0, 1)),
    radius_ratio: round(1 + 0.35 * Math.max(clamp(defect, 0, 1), clamp(crack, 0, 1))),
    manifest_fraction: round(clamp(retention, 0, 1)),
    buffer_score: round(clamp(margin, 0, 1)),
  };
}

function adaptEnergy(row: Record<string, unknown>): HFCDGates {
  const soh = firstFinite([safeNumber(row, 'SOH'), safeNumber(row, 'capacity_retention')], 0.95);
  const impedance = safeNumber(row, 'impedance_growth_norm', 0.1) as number;
  const thermal = safeNumber(row, 'thermal_risk_norm', 0.2) as number;
  const ce = safeNumber(row, 'coulombic_efficiency', 0.995) as number;
  const stability = safeNumber(row, 'interface_stability', 0.9) as number;
  const spread = safeNumber(row, 'degradation_spread_norm', 0.1) as number;
  const reserve = safeNumber(row, 'reserve_margin', 0.8) as number;
  return {
    Q_error: round(0.03 * (1 - clamp(soh, 0, 1))),
    energy_drift_per_q: round(0.02 + 0.035 * clamp(impedance, 0, 1) + 0.035 * clamp(thermal, 0, 1)),
    cavity_peak_ratio: round(0.75 + 0.25 * clamp(stability, 0, 1)),
    peak_ratio: round(0.7 + 0.4 * clamp(soh, 0, 1)),
    radius_ratio: round(1 + 0.38 * clamp(spread, 0, 1)),
    manifest_fraction: round(clamp(ce, 0, 1)),
    buffer_score: round(clamp(reserve, 0, 1)),
  };
}

function adaptBio(row: Record<string, unknown>): HFCDGates {
  const identity = safeNumber(row, 'cell_identity', 0.95) as number;
  const viability = safeNumber(row, 'viability', 0.95) as number;
  const productivity = safeNumber(row, 'productivity_retention', 0.9) as number;
  const metabolic = safeNumber(row, 'metabolic_load_norm', 0.2) as number;
  const heterogeneity = safeNumber(row, 'heterogeneity_norm', 0.1) as number;
  const culture = safeNumber(row, 'culture_support', 0.9) as number;
  const reserve = safeNumber(row, 'stress_reserve', 0.8) as number;
  const cqa = firstFinite([safeNumber(row, 'CQA_pass_fraction'), safeNumber(row, 'productivity_retention')], productivity);
  return {
    Q_error: round(0.03 * (1 - clamp(identity, 0, 1))),
    energy_drift_per_q: round(0.02 + 0.06 * clamp(metabolic, 0, 1)),
    cavity_peak_ratio: round(0.75 + 0.25 * clamp(culture, 0, 1)),
    peak_ratio: round(0.6 + 0.45 * Math.min(clamp(viability, 0, 1), clamp(productivity, 0, 1))),
    radius_ratio: round(1 + 0.4 * clamp(heterogeneity, 0, 1)),
    manifest_fraction: round(clamp(cqa, 0, 1)),
    buffer_score: round(clamp(reserve, 0, 1)),
  };
}

const ADAPTERS: Record<HFCDIndustry, (row: Record<string, unknown>) => HFCDGates> = {
  quantum: adaptQuantum,
  materials: adaptMaterials,
  energy: adaptEnergy,
  bio: adaptBio,
};

export function validateRows(rows: Array<Record<string, unknown>>, industry: HFCDIndustry) {
  const spec = HFCD_INDUSTRIES[industry];
  const presentFields = new Set(rows.flatMap((row) => Object.keys(row).filter((key) => row[key] !== '')));
  const missingRequired = spec.fields.filter((field) => field.required && !presentFields.has(field.key)).map((field) => field.key);
  const availableFields = spec.fields.filter((field) => presentFields.has(field.key)).map((field) => field.key);
  const computableFields = spec.fields.filter((field) => presentFields.has(field.key) && field.key !== 'actual_failure').map((field) => field.key);
  const suggestedFields = spec.fields.filter((field) => !presentFields.has(field.key) && !field.required).map((field) => field.key);
  const fieldHealth: HFCDFieldHealth[] = spec.fields.map((field) => {
    const profile = getFieldProfile(industry, field.key);
    const present = presentFields.has(field.key);
    const gate =
      profile.hfcdGate && profile.hfcdGate !== 'identity' && profile.hfcdGate !== 'blind_label'
        ? HFCD_GATE_EXPLANATIONS[profile.hfcdGate]
        : null;
    return {
      key: profile.key,
      label: profile.label,
      present,
      required: profile.required,
      hfcdGate: profile.hfcdGate,
      effect:
        profile.hfcdGate === 'identity'
          ? '用于样本追踪，不参与风险分。'
          : profile.hfcdGate === 'blind_label'
            ? '用于盲测验证，不参与当前风险分调参。'
            : gate
              ? `影响 ${gate.label}（${profile.hfcdGate}）。`
              : '用于辅助解释和后续扩展。',
      guidance: present
        ? `已检测。${profile.plainMeaning || profile.description}`
        : profile.required
          ? `缺少必填字段。${profile.description}`
          : `建议补充。${profile.riskSignal || profile.description}`,
    };
  });

  return {
    missingRequired,
    availableFields,
    computableFields,
    suggestedFields,
    fieldHealth,
    isValid: rows.length > 0 && missingRequired.length === 0,
  };
}

export function detectHFCDIndustry(rows: Array<Record<string, unknown>>, fallback: HFCDIndustry = 'quantum') {
  if (!rows.length) return fallback;
  const presentFields = new Set(rows.flatMap((row) => Object.keys(row).filter((key) => row[key] !== '')));
  const scores = (Object.keys(HFCD_INDUSTRIES) as HFCDIndustry[]).map((candidate) => {
    const spec = HFCD_INDUSTRIES[candidate];
    const fieldKeys = spec.fields.map((field) => field.key);
    const presentKnown = fieldKeys.filter((field) => presentFields.has(field)).length;
    const requiredPresent = spec.fields.filter((field) => field.required && presentFields.has(field.key)).length;
    const currentIndustryPenalty = candidate === fallback ? 0.1 : 0;
    return {
      candidate,
      score: presentKnown + requiredPresent * 2 + currentIndustryPenalty,
    };
  });
  scores.sort((a, b) => b.score - a.score);
  return scores[0]?.score ? scores[0].candidate : fallback;
}

export function evaluateGates(gates: HFCDGates, thresholds: Partial<HFCDGates> = HFCD_THRESHOLDS): HFCDGateStatus {
  const safeThresholds = mergeThresholds(thresholds);
  return {
    Q_safe: gates.Q_error <= safeThresholds.Q_error,
    E_safe: gates.energy_drift_per_q <= safeThresholds.energy_drift_per_q,
    C_safe: gates.cavity_peak_ratio >= safeThresholds.cavity_peak_ratio,
    P_safe: gates.peak_ratio >= safeThresholds.peak_ratio,
    R_safe: gates.radius_ratio <= safeThresholds.radius_ratio,
    M_safe: gates.manifest_fraction >= safeThresholds.manifest_fraction,
    B_safe: gates.buffer_score >= safeThresholds.buffer_score,
  };
}

export function isStrictStable(status: HFCDGateStatus) {
  return Object.values(status).every(Boolean);
}

export function isLooseStable(status: HFCDGateStatus) {
  return status.Q_safe && status.C_safe && status.P_safe && status.M_safe;
}

export function classifyFailure(
  gates: HFCDGates,
  status: HFCDGateStatus,
  thresholds: Partial<HFCDGates> = HFCD_THRESHOLDS,
): HFCDFailureMode {
  const safeThresholds = mergeThresholds(thresholds);
  if (isStrictStable(status)) return 'stable';
  if (!status.Q_safe) {
    return gates.radius_ratio > safeThresholds.radius_ratio ? 'radius_induced_Q_loss' : 'Q_loss';
  }
  if (!status.M_safe) return 'manifest_underthreshold';
  if (!status.C_safe) return 'cavity_underfill';
  if (!status.P_safe) return 'core_decay';
  if (!status.R_safe) return gates.peak_ratio > 1.45 ? 'high_peak_radius_outlier' : 'de_localized';
  if (!status.E_safe) {
    if (
      gates.energy_drift_per_q <= safeThresholds.energy_drift_per_q + 0.003 &&
      status.Q_safe &&
      status.C_safe &&
      status.P_safe &&
      status.R_safe &&
      status.M_safe
    ) {
      return 'ultra_micro_energy_surplus';
    }
    return 'energy_surplus_overflow';
  }
  if (!status.B_safe) return 'buffer_decay';
  return 'unknown_boundary';
}

export function planRepair(industry: HFCDIndustry, failureMode: HFCDFailureMode) {
  return `${BASE_REPAIR_PLANS[failureMode]} ${INDUSTRY_APPENDIX[industry][failureMode] || ''}`.trim();
}

const STATUS_TO_GATE: Record<keyof HFCDGateStatus, keyof HFCDGates> = {
  Q_safe: 'Q_error',
  E_safe: 'energy_drift_per_q',
  C_safe: 'cavity_peak_ratio',
  P_safe: 'peak_ratio',
  R_safe: 'radius_ratio',
  M_safe: 'manifest_fraction',
  B_safe: 'buffer_score',
};

const FAILURE_BUSINESS_MEANING: Record<HFCDFailureMode, string> = {
  stable: '该样本各项关键指标全部达标，可作为当前批次的参考样本继续复测或盲测确认。',
  Q_loss: '核心状态已经退化。这不是单个参数的小波动，而是关键对象本身的稳定性正在下降。',
  radius_induced_Q_loss: '风险扩散范围过大，并且已经拖累核心状态。应先控制扩散，再修复核心指标。',
  manifest_underthreshold: '系统看似还在运行，但实际交付或达标比例不足，已经影响可用结果。',
  cavity_underfill: '支撑条件不足。关键输出没有被环境、结构或工艺条件稳定承接，继续加大输入会提高失稳概率。',
  core_decay: '关键性能已经低于稳定输出线。系统还没完全失效，但核心能力正在下滑。',
  de_localized: '风险正在从局部问题扩散到系统层面，需要先做局部收敛。',
  high_peak_radius_outlier: '输出能力很强，但带来了明显外溢风险，需要在保持性能的同时收窄风险范围。',
  energy_surplus_overflow: '运行负荷过高或输入输出不匹配。系统不是资源不足，而是负荷没有被稳定消化。',
  ultra_micro_energy_surplus: '系统接近达标，只剩小幅负荷偏高，应微调而不是重做。',
  buffer_decay: '安全余量不足。当前状态可能还能运行，但抗扰动能力已经被消耗。',
  unknown_boundary: '该样本落在未知边界，需要人工复核并沉淀新的风险类型。',
};

function failedGateKeys(status: HFCDGateStatus) {
  return (Object.keys(status) as Array<keyof HFCDGateStatus>)
    .filter((key) => !status[key])
    .map((key) => STATUS_TO_GATE[key]);
}

function formatGateValue(gates: HFCDGates, gate: keyof HFCDGates) {
  const explanation = HFCD_GATE_EXPLANATIONS[gate];
  return `${explanation.label} ${gate}=${gates[gate]}（安全线：${explanation.safeRule}）`;
}

function getSeverity(strictStable: boolean, looseStable: boolean, riskScore: number): HFCDReadableDiagnosis['severity'] {
  if (strictStable) return '稳定';
  if (looseStable && riskScore < 0.43) return '临界';
  return '高风险';
}

export function buildReadableDiagnosis(params: {
  industry: HFCDIndustry;
  gates: HFCDGates;
  status: HFCDGateStatus;
  failureMode: HFCDFailureMode;
  strictStable: boolean;
  looseStable: boolean;
  riskScore: number;
  repairPlan: string;
}): HFCDReadableDiagnosis {
  const { gates, status, failureMode, strictStable, looseStable, riskScore, repairPlan } = params;
  const failedGates = failedGateKeys(status);
  const severity = getSeverity(strictStable, looseStable, riskScore);
  const primaryDrivers =
    failedGates.length > 0
      ? failedGates.map((gate) => HFCD_GATE_EXPLANATIONS[gate].label)
      : ['七类关键指标全部达标'];
  const failedText = failedGates.length
    ? failedGates.map((gate) => formatGateValue(gates, gate)).join('；')
    : '七类关键指标全部达标。';
  const businessSummary =
    failureMode === 'stable'
      ? FAILURE_BUSINESS_MEANING.stable
      : `${FAILURE_BUSINESS_MEANING[failureMode]} 当前风险分 ${riskScore}，严重度判定为“${severity}”。`;
  const hfcdSummary = `系统判定：${failedText}`;
  const repairSummary =
    failureMode === 'stable'
      ? '保持当前参数窗口，不做大幅改动；把该样本作为稳定参照，进入复测、盲测确认或下一轮长周期验证。'
      : repairPlan;

  return {
    severity,
    businessSummary,
    hfcdSummary,
    repairSummary,
    failedGates: failedGates.map((gate) => `${gate}: ${HFCD_GATE_EXPLANATIONS[gate].label}`),
    primaryDrivers,
  };
}

function buildAuditResultFromGates(
  row: Record<string, unknown>,
  industry: HFCDIndustry,
  gates: HFCDGates,
  thresholds: Partial<HFCDGates> = HFCD_THRESHOLDS,
): HFCDAuditResult {
  const safeThresholds = mergeThresholds(thresholds);
  const status = evaluateGates(gates, safeThresholds);
  const failureMode = classifyFailure(gates, status, safeThresholds);
  const strictStable = isStrictStable(status);
  const looseStable = isLooseStable(status);
  const riskScore = round(1 - Object.values(status).filter(Boolean).length / 7);
  const repairPlan = planRepair(industry, failureMode);
  const actualFailure = safeNumber(row, 'actual_failure');
  const baselineScore = safeNumber(row, 'baseline_score');
  const warningLeadTime = firstFinite(
    [safeNumber(row, 'lead_time_days'), safeNumber(row, 'warning_lead_time_days'), safeNumber(row, 'time_to_failure_days')],
    Number.NaN,
  );
  return {
    sample_id: String(row.sample_id || 'unknown_sample'),
    gates,
    gate_status: status,
    strict_stable: strictStable,
    loose_stable: looseStable,
    failure_mode: failureMode,
    risk_score: riskScore,
    repair_plan: repairPlan,
    readable: buildReadableDiagnosis({
      industry,
      gates,
      status,
      failureMode,
      strictStable,
      looseStable,
      riskScore,
      repairPlan,
    }),
    actual_failure: actualFailure === undefined ? null : actualFailure,
    baseline_score: baselineScore === undefined ? null : baselineScore,
    warning_lead_time: Number.isFinite(warningLeadTime) ? warningLeadTime : null,
  };
}

export function auditRecord(
  row: Record<string, unknown>,
  industry: HFCDIndustry,
  options: { thresholds?: Partial<HFCDGates> } = {},
): HFCDAuditResult {
  const gates = ADAPTERS[industry](row);
  return buildAuditResultFromGates(row, industry, gates, options.thresholds);
}

export function flattenAuditResult(result: HFCDAuditResult) {
  return {
    sample_id: result.sample_id,
    ...result.gates,
    ...result.gate_status,
    strict_stable: result.strict_stable,
    loose_stable: result.loose_stable,
    failure_mode: result.failure_mode,
    risk_score: result.risk_score,
    actual_failure: result.actual_failure ?? '',
    baseline_score: result.baseline_score ?? '',
    warning_lead_time: result.warning_lead_time ?? '',
    severity: result.readable.severity,
    business_summary: result.readable.businessSummary,
    hfcd_summary: result.readable.hfcdSummary,
    primary_drivers: result.readable.primaryDrivers.join('; '),
    repair_plan: result.repair_plan,
  };
}

export function auditRecords(
  rows: Array<Record<string, unknown>>,
  industry: HFCDIndustry,
  options: { thresholds?: Partial<HFCDGates> } = {},
) {
  return rows.map((row) => auditRecord(row, industry, options));
}

export function learnHFCDParameters(rows: Array<Record<string, unknown>>, industry: HFCDIndustry): HFCDParameterProfile {
  const allGates = rows.map((row) => ADAPTERS[industry](row));
  const baselineResults = auditRecords(rows, industry);
  const labeledRows = rows.filter((row) => readActualFailure(row) !== null);
  const stableLabelRows = rows.filter((row) => readActualFailure(row) === 0);
  const failureLabelRows = rows.filter((row) => readActualFailure(row) === 1);
  const baselineStableRows = rows.filter((_, index) => baselineResults[index]?.loose_stable || baselineResults[index]?.strict_stable);

  const learningRows =
    stableLabelRows.length > 0
      ? stableLabelRows
      : baselineStableRows.length > 0
        ? baselineStableRows
        : rows;
  const learnedFrom: HFCDParameterProfile['learnedFrom'] =
    rows.length === 0
      ? 'empty'
      : stableLabelRows.length > 0
        ? 'actual_failure_0'
        : baselineStableRows.length > 0
          ? 'baseline_stable'
          : 'all_samples';
  const learningGates = learningRows.map((row) => ADAPTERS[industry](row));
  const gateStats = calculateGateStats(allGates);
  const learningStats = calculateGateStats(learningGates);
  const thresholds = HFCD_GATE_KEYS.reduce((next, gate) => {
    const base = HFCD_THRESHOLDS[gate];
    const stats = learningStats[gate];
    const [lo, hi] = HFCD_THRESHOLD_LIMITS[gate];
    const candidate = HFCD_UPPER_LIMIT_GATES.has(gate)
      ? Math.max(base * 0.78, Math.min(base * 1.22, stats.p75 * 1.08 || base))
      : Math.max(base * 0.82, Math.min(base * 1.16, stats.p25 * 0.96 || base));
    next[gate] = round(clamp(candidate, lo, hi));
    return next;
  }, {} as HFCDGates);

  const warnings: string[] = [];
  if (rows.length === 0) {
    warnings.push('未检测到样本，已返回默认参数。');
  }
  if (labeledRows.length === 0) {
    warnings.push('未提供 actual_failure 标签，本次只能从当前样本分布推断候选参数，建议补充历史失效标签后再校准。');
  } else if (labeledRows.length < 8) {
    warnings.push('带标签样本少于 8 条，当前参数适合试运行，不建议直接作为生产冻结参数。');
  }
  if (stableLabelRows.length === 0 && failureLabelRows.length > 0) {
    warnings.push('只有失效样本，没有未失效样本，系统会保守使用当前稳定样本或全量样本估计安全线。');
  }

  return {
    id: `profile_${industry}_${rows.length}_${Date.now()}`,
    industry,
    sampleCount: rows.length,
    labeledCount: labeledRows.length,
    stableLabelCount: stableLabelRows.length,
    failureLabelCount: failureLabelRows.length,
    generatedAt: Date.now(),
    thresholds: rows.length ? thresholds : HFCD_THRESHOLDS,
    baselineThresholds: HFCD_THRESHOLDS,
    gateStats,
    learnedFrom,
    recommendedUse:
      learnedFrom === 'actual_failure_0'
        ? '已基于客户历史未失效样本校准候选安全线，可用于下一轮冻结参数盲测。'
        : '当前为无标签或弱标签候选参数，适合研发探索和客户演示；正式上线前应补充 actual_failure 标签做盲测验证。',
    warnings,
  };
}

function applySimulationScenario(gates: HFCDGates, scenario: HFCDSimulationScenario): HFCDGates {
  return HFCD_GATE_KEYS.reduce((next, gate) => {
    const multiplier = scenario.multipliers[gate] ?? 1;
    const offset = scenario.offsets?.[gate] ?? 0;
    next[gate] = clampGateValue(gate, gates[gate] * multiplier + offset);
    return next;
  }, {} as HFCDGates);
}

export function simulateHFCDScenarios(
  rows: Array<Record<string, unknown>>,
  industry: HFCDIndustry,
  profile = learnHFCDParameters(rows, industry),
): HFCDSimulationReport {
  const thresholds = profile.thresholds;
  const baselineResults = auditRecords(rows, industry, { thresholds });
  const baselineSummary = summarizeAudit(baselineResults);
  const scenarios = HFCD_SIMULATION_SCENARIOS.map((scenario) => {
    const scenarioResults =
      scenario.id === 'baseline'
        ? baselineResults
        : rows.map((row) =>
            buildAuditResultFromGates(
              row,
              industry,
              applySimulationScenario(ADAPTERS[industry](row), scenario),
              thresholds,
            ),
          );
    const summary = summarizeAudit(scenarioResults);
    const strictStableGain = summary.strictStableCount - baselineSummary.strictStableCount;
    const highRiskReduction = baselineSummary.highRiskCount - summary.highRiskCount;
    const averageRiskScoreDelta = round(baselineSummary.averageRiskScore - summary.averageRiskScore, 4);
    const improvementScore = round(strictStableGain * 1.2 + highRiskReduction * 1.8 + averageRiskScoreDelta * 12, 4);
    return {
      scenario,
      summary,
      results: scenarioResults,
      strictStableGain,
      highRiskReduction,
      averageRiskScoreDelta,
      improvementScore,
    };
  });
  const recommended =
    scenarios
      .filter((item) => item.scenario.id !== 'baseline')
      .sort((a, b) => b.improvementScore - a.improvementScore)[0] || scenarios[0];

  return {
    industry,
    generatedAt: Date.now(),
    profile,
    baselineSummary,
    scenarios,
    recommendedScenarioId: recommended.scenario.id,
  };
}

function summarizeFieldState(
  step: number,
  gateSets: HFCDGates[],
  rows: Array<Record<string, unknown>>,
  industry: HFCDIndustry,
  thresholds: HFCDGates,
): HFCDFieldTrajectoryPoint {
  const results = gateSets.map((gates, index) => buildAuditResultFromGates(rows[index] || {}, industry, gates, thresholds));
  const summary = summarizeAudit(results);
  const energyHeadroom = mean(gateSets.map((gates) => 1 - gates.energy_drift_per_q / Math.max(thresholds.energy_drift_per_q, 1e-9)));
  const riskPressure = summary.sampleCount ? summary.highRiskCount / summary.sampleCount : 0;
  const stabilityIndex = summary.sampleCount
    ? round((summary.strictStableCount / summary.sampleCount) * 0.55 + (summary.looseStableCount / summary.sampleCount) * 0.25 + Math.max(0, 1 - summary.averageRiskScore) * 0.2, 4)
    : 0;
  return {
    step,
    strictStableCount: summary.strictStableCount,
    looseStableCount: summary.looseStableCount,
    highRiskCount: summary.highRiskCount,
    averageRiskScore: summary.averageRiskScore,
    stabilityIndex,
    energyClosure: round(clamp(energyHeadroom * 0.7 + (1 - riskPressure) * 0.3, 0, 1), 4),
  };
}

function evolveFieldGates(
  gates: HFCDGates,
  scenario: HFCDSimulationScenario,
  input: HFCDNormalizedFieldSimulationInput,
  stepGain: number,
): HFCDGates {
  const { physical, process, boundary, digitalTwin, scan } = input;
  const twinQuality = mean([
    digitalTwin.coverage,
    digitalTwin.fidelity,
    digitalTwin.parameterCompleteness,
    digitalTwin.historicalDepth,
  ]);
  const support = mean([process.materialSupport, boundary.boundaryTightness, boundary.safetyReserve, twinQuality]);
  const coherence = mean([physical.qIdentityRigidity, physical.coherenceRetention, physical.fieldCoupling]);
  const control = mean([process.controlGain, process.repairIntensity, scan.scanDepth]);
  const pressure = mean([
    physical.thermalLoad,
    physical.entropyPressure,
    process.processDrift,
    process.measurementNoise,
    boundary.externalShock,
  ]);
  const scenarioBias = {
    core: scenario.multipliers.Q_error ? Math.max(0, 1 - scenario.multipliers.Q_error) : 0.04,
    load: scenario.multipliers.energy_drift_per_q ? Math.max(0, 1 - scenario.multipliers.energy_drift_per_q) : 0.04,
    support: scenario.multipliers.cavity_peak_ratio ? Math.max(0, scenario.multipliers.cavity_peak_ratio - 1) : 0.03,
    radius: scenario.multipliers.radius_ratio ? Math.max(0, 1 - scenario.multipliers.radius_ratio) : 0.03,
    buffer: scenario.multipliers.buffer_score ? Math.max(0, scenario.multipliers.buffer_score - 1) : 0.04,
    delivery: scenario.multipliers.manifest_fraction ? Math.max(0, scenario.multipliers.manifest_fraction - 1) : 0.03,
  };
  const resolutionDamping = clamp(boundary.gridResolution / 128, 0.14, 1);
  const gain = stepGain * scan.stepSize * resolutionDamping;
  const drift = gain * pressure * (1 - support) * 0.42;

  return {
    Q_error: clampGateValue(
      'Q_error',
      gates.Q_error * (1 - gain * (0.55 * control + 0.45 * coherence + scenarioBias.core)) + drift * 0.16,
    ),
    energy_drift_per_q: clampGateValue(
      'energy_drift_per_q',
      gates.energy_drift_per_q * (1 - gain * (0.5 * control + scenarioBias.load)) + gain * physical.thermalLoad * 0.035 + drift * 0.12,
    ),
    cavity_peak_ratio: clampGateValue(
      'cavity_peak_ratio',
      gates.cavity_peak_ratio + gain * (0.18 * support + 0.1 * twinQuality + scenarioBias.support) - gain * pressure * 0.08,
    ),
    peak_ratio: clampGateValue(
      'peak_ratio',
      gates.peak_ratio + gain * (0.12 * coherence + 0.1 * control + scenarioBias.delivery) - gain * physical.thermalLoad * 0.06,
    ),
    radius_ratio: clampGateValue(
      'radius_ratio',
      gates.radius_ratio * (1 - gain * (0.34 * boundary.boundaryTightness + 0.22 * control + scenarioBias.radius)) + gain * pressure * 0.028,
    ),
    manifest_fraction: clampGateValue(
      'manifest_fraction',
      gates.manifest_fraction + gain * (0.16 * support + 0.14 * twinQuality + scenarioBias.delivery) - gain * pressure * 0.07,
    ),
    buffer_score: clampGateValue(
      'buffer_score',
      gates.buffer_score + gain * (0.18 * boundary.safetyReserve + 0.12 * support + scenarioBias.buffer) - gain * pressure * 0.08,
    ),
  };
}

export function runHFCDFieldSimulation(params: {
  rows: Array<Record<string, unknown>>;
  industry: HFCDIndustry;
  profile?: HFCDParameterProfile;
  input?: HFCDFieldSimulationInput;
}): HFCDFieldSimulationReport {
  const { rows, industry } = params;
  const profile = params.profile || learnHFCDParameters(rows, industry);
  const input = normalizeHFCDFieldSimulationInput(params.input, industry);
  const thresholds = profile.thresholds;
  const baselineResults = auditRecords(rows, industry, { thresholds });
  const baselineSummary = summarizeAudit(baselineResults);
  const scenarioPool = HFCD_SIMULATION_SCENARIOS.filter((scenario) => scenario.id !== 'baseline').slice(0, input.scan.candidateCount);
  const baseGates = rows.map((row) => ADAPTERS[industry](row));
  const sampleRows = rows.length ? rows : HFCD_INDUSTRIES[industry].sampleRows;
  const initialGates = baseGates.length ? baseGates : sampleRows.map((row) => ADAPTERS[industry](row));
  const steps = input.boundary.timeHorizon;
  const checkpointEvery = Math.max(1, Math.floor(steps / 8));

  const candidates = scenarioPool.map((scenario) => {
    let currentGates = initialGates.map((gates) => ({ ...gates }));
    const trajectory: HFCDFieldTrajectoryPoint[] = [
      summarizeFieldState(0, currentGates, sampleRows, industry, thresholds),
    ];

    for (let step = 1; step <= steps; step += 1) {
      const stepGain = 1 + (step / steps) * input.scan.scanDepth;
      currentGates = currentGates.map((gates) => evolveFieldGates(gates, scenario, input, stepGain));
      if (step % checkpointEvery === 0 || step === steps) {
        trajectory.push(summarizeFieldState(step, currentGates, sampleRows, industry, thresholds));
      }
    }

    const finalResults = currentGates.map((gates, index) =>
      buildAuditResultFromGates(sampleRows[index] || {}, industry, gates, thresholds),
    );
    const summary = summarizeAudit(finalResults);
    const finalPoint = trajectory[trajectory.length - 1];
    const stabilityGain = finalPoint.stabilityIndex - (trajectory[0]?.stabilityIndex || 0);
    const highRiskReduction = baselineSummary.highRiskCount - summary.highRiskCount;
    const averageRiskReduction = baselineSummary.averageRiskScore - summary.averageRiskScore;
    const twinQuality = mean([
      input.digitalTwin.coverage,
      input.digitalTwin.fidelity,
      input.digitalTwin.parameterCompleteness,
      input.digitalTwin.historicalDepth,
    ]);
    const confidence = round(clamp(0.25 + twinQuality * 0.45 + (profile.labeledCount > 0 ? 0.18 : 0) + Math.min(rows.length, 50) / 50 * 0.12, 0, 0.98), 4);
    const convergenceScore = round(finalPoint.stabilityIndex * 0.45 + finalPoint.energyClosure * 0.35 + Math.max(0, 1 - summary.averageRiskScore) * 0.2, 4);
    const predictedGain = round(stabilityGain * 1.8 + highRiskReduction * 0.35 + averageRiskReduction * 1.4, 4);

    return {
      scenarioId: scenario.id,
      name: scenario.name,
      target: scenario.target,
      summary,
      results: finalResults,
      trajectory,
      stabilityIndex: finalPoint.stabilityIndex,
      energyClosure: finalPoint.energyClosure,
      convergenceScore,
      predictedGain,
      confidence,
    };
  });
  const recommended =
    candidates
      .sort((a, b) => b.predictedGain + b.convergenceScore - (a.predictedGain + a.convergenceScore))[0] || candidates[0];
  const requirements = [
    '物理参数：核心身份刚性、相干保持、耦合强度、热负荷、熵压。',
    '工艺参数：控制增益、工艺漂移、修复强度、测量噪声、材料/环境支撑。',
    '边界条件：边界收紧度、外部冲击、安全余量、仿真步长、网格分辨率。',
    '数字孪生输入：覆盖度、保真度、参数完整度、历史深度。',
  ];

  return {
    model: 'hfcd-field-v1',
    industry,
    generatedAt: Date.now(),
    input,
    requirements,
    profile,
    baselineSummary,
    candidates,
    recommendedCandidateId: recommended?.scenarioId || 'baseline',
  };
}

export function summarizeAudit(results: HFCDAuditResult[]): HFCDAuditSummary {
  const failureModeCounts = results.reduce<Record<string, number>>((counts, result) => {
    counts[result.failure_mode] = (counts[result.failure_mode] || 0) + 1;
    return counts;
  }, {});
  const primaryFailureMode =
    Object.entries(failureModeCounts)
      .filter(([mode]) => mode !== 'stable')
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'none';

  return {
    sampleCount: results.length,
    strictStableCount: results.filter((result) => result.strict_stable).length,
    looseStableCount: results.filter((result) => result.loose_stable).length,
    highRiskCount: results.filter((result) => result.risk_score >= 0.43).length,
    primaryFailureMode: primaryFailureMode as HFCDFailureMode | 'none',
    failureModeCounts,
    averageRiskScore: round(mean(results.map((result) => result.risk_score)), 4),
  };
}

export function summarizeGateSafety(results: HFCDAuditResult[]): HFCDGateSafetySummary[] {
  const statusKeys: Array<[keyof HFCDGateStatus, keyof HFCDGates]> = [
    ['Q_safe', 'Q_error'],
    ['E_safe', 'energy_drift_per_q'],
    ['C_safe', 'cavity_peak_ratio'],
    ['P_safe', 'peak_ratio'],
    ['R_safe', 'radius_ratio'],
    ['M_safe', 'manifest_fraction'],
    ['B_safe', 'buffer_score'],
  ];

  return statusKeys.map(([statusKey, gate]) => {
    const safeCount = results.filter((result) => result.gate_status[statusKey]).length;
    const failCount = Math.max(0, results.length - safeCount);
    return {
      gate,
      label: HFCD_GATE_EXPLANATIONS[gate].label,
      safeCount,
      failCount,
      safeRate: results.length ? round(safeCount / results.length, 4) : 0,
    };
  });
}

function calculateAuc(items: Array<{ score: number; label: 0 | 1 }>) {
  const positives = items.filter((item) => item.label === 1);
  const negatives = items.filter((item) => item.label === 0);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  positives.forEach((positive) => {
    negatives.forEach((negative) => {
      if (positive.score > negative.score) wins += 1;
      if (positive.score === negative.score) wins += 0.5;
    });
  });
  return round(wins / (positives.length * negatives.length), 4);
}

function calculatePrecisionTop10(items: Array<{ score: number; label: 0 | 1 }>) {
  const topCount = Math.max(1, Math.ceil(items.length * 0.1));
  const topRisk = [...items].sort((a, b) => b.score - a.score).slice(0, topCount);
  return topRisk.length ? round(topRisk.filter((item) => item.label === 1).length / topRisk.length, 4) : null;
}

export function validateBlindMetrics(results: HFCDAuditResult[]): HFCDValidationSummary {
  const labeled = results
    .map((result) => ({
      score: result.risk_score,
      label: result.actual_failure === 1 ? 1 : result.actual_failure === 0 ? 0 : null,
    }))
    .filter((item): item is { score: number; label: 0 | 1 } => item.label !== null);

  const auc = calculateAuc(labeled);
  const precisionTop10 = calculatePrecisionTop10(labeled);
  const baselineLabeled = results
    .map((result) => ({
      score: result.baseline_score,
      label: result.actual_failure === 1 ? 1 : result.actual_failure === 0 ? 0 : null,
    }))
    .filter((item): item is { score: number; label: 0 | 1 } => item.label !== null && typeof item.score === 'number');
  const baselinePrecisionTop10 = baselineLabeled.length ? calculatePrecisionTop10(baselineLabeled) : null;
  const leadTimes = results
    .filter((result) => result.actual_failure === 1 && result.risk_score >= 0.43 && typeof result.warning_lead_time === 'number')
    .map((result) => result.warning_lead_time as number);
  const positives = labeled.filter((item) => item.label === 1);
  const failureRate = labeled.length ? round(positives.length / labeled.length, 4) : null;

  return {
    sampleCount: results.length,
    hasActualFailure: labeled.length > 0,
    auc,
    precisionTop10,
    baselineAuc: baselineLabeled.length ? calculateAuc(baselineLabeled) : null,
    baselinePrecisionTop10,
    precisionLift:
      precisionTop10 !== null && baselinePrecisionTop10 !== null
        ? round(precisionTop10 - baselinePrecisionTop10, 4)
        : null,
    warningLeadTimeAvg: leadTimes.length ? round(mean(leadTimes), 4) : null,
    highRiskCount: results.filter((result) => result.risk_score >= 0.43).length,
    failureRateTop10: failureRate,
  };
}

export function generateMarkdownReport(params: {
  projectName: string;
  industry: HFCDIndustry;
  results: HFCDAuditResult[];
}) {
  const { projectName, industry, results } = params;
  const spec = HFCD_INDUSTRIES[industry];
  const summary = summarizeAudit(results);
  const validation = validateBlindMetrics(results);
  const gateSafety = summarizeGateSafety(results);
  const fieldProfiles = getIndustryFieldProfiles(industry);
  const topRisk = [...results].sort((a, b) => b.risk_score - a.risk_score).slice(0, 10);
  const tableCell = (value: unknown) => String(value ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const labelFailureMode = (mode: HFCDFailureMode | 'none') => mode === 'none' ? '无明显主要风险' : FAILURE_MODE_LABELS[mode];
  const executiveConclusion =
    summary.highRiskCount > 0
      ? `本批数据已经出现 ${summary.highRiskCount} 个高风险样本，主要风险类型为 ${labelFailureMode(summary.primaryFailureMode)}。建议先处理风险最高的样本，再做全批次参数收束。`
      : summary.strictStableCount === summary.sampleCount && summary.sampleCount > 0
        ? '本批数据整体处于全部达标状态，可作为当前阶段的参考窗口进入复测、盲测或更长周期验证。'
        : `本批数据处于临界状态，主要风险类型为 ${labelFailureMode(summary.primaryFailureMode)}。建议优先修复未通过的关键指标，再扩大样本验证。`;
  const failureRows = Object.entries(summary.failureModeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([mode, count]) => `| ${tableCell(labelFailureMode(mode as HFCDFailureMode))} | ${count} |`)
    .join('\n');
  const fieldRows = fieldProfiles
    .map(
      (field) =>
        `| ${field.key} | ${tableCell(field.label)} | ${tableCell(field.unit || '-')} | ${tableCell(field.goodRange || '-')} | ${tableCell(field.plainMeaning || field.description)} | ${tableCell(field.riskSignal || '-')} |`,
    )
    .join('\n');
  const gateRows = (Object.keys(HFCD_GATE_EXPLANATIONS) as Array<keyof HFCDGates>)
    .map((gate) => {
      const explanation = HFCD_GATE_EXPLANATIONS[gate];
      return `| ${gate} | ${explanation.label} | ${tableCell(explanation.safeRule)} | ${tableCell(explanation.businessMeaning)} |`;
    })
    .join('\n');
  const gateSafetyRows = gateSafety
    .map((gate) => `| ${gate.gate} | ${gate.label} | ${gate.safeCount} | ${gate.failCount} | ${round(gate.safeRate * 100, 2)}% |`)
    .join('\n');
  const topRows = topRisk
    .map(
      (result) =>
        `| ${tableCell(result.sample_id)} | ${result.readable.severity} | ${result.risk_score} | ${labelFailureMode(result.failure_mode)} | ${tableCell(result.readable.businessSummary)} | ${tableCell(result.readable.hfcdSummary)} | ${tableCell(result.readable.repairSummary)} |`,
    )
    .join('\n');

  return [
    `# ${projectName || 'HFCD 稳定窗审计报告'}`,
    '',
    `行业：${spec.title}`,
    '',
    '## Executive Summary',
    '',
    executiveConclusion,
    '',
    '本报告采用 HFCD Stability-Window Audit：把行业数据转换成七类稳定性指标，输出业务风险解释、关键指标证据和研发修复方案。它适合客户初筛、历史数据盲测和研发复盘。',
    '',
    '## 关键指标',
    '',
    `- 样本数：${summary.sampleCount}`,
    `- 全部达标样本：${summary.strictStableCount}`,
    `- 核心达标样本：${summary.looseStableCount}`,
    `- 高风险样本：${summary.highRiskCount}`,
    `- 主要风险类型：${labelFailureMode(summary.primaryFailureMode)}`,
    `- 平均风险分：${summary.averageRiskScore}`,
    '',
    '## 七类稳定性指标解释',
    '',
    '| 指标代码 | 名称 | 安全线 | 业务意义 |',
    '|---|---|---|---|',
    gateRows,
    '',
    '## 字段体检与解释',
    '',
    '| 字段 | 名称 | 单位 | 推荐区间 | 用户要怎么理解 | 风险信号 |',
    '|---|---|---|---|---|---|',
    fieldRows,
    '',
    '## 盲测指标',
    '',
    `- actual_failure 标签：${validation.hasActualFailure ? '已检测' : '未提供'}`,
    `- AUC：${validation.auc ?? 'N/A'}`,
    `- precision@top10%：${validation.precisionTop10 ?? 'N/A'}`,
    `- baseline AUC：${validation.baselineAuc ?? 'N/A'}`,
    `- baseline precision@top10%：${validation.baselinePrecisionTop10 ?? 'N/A'}`,
    `- HFCD precision lift：${validation.precisionLift ?? 'N/A'}`,
    `- 平均提前预警天数：${validation.warningLeadTimeAvg ?? 'N/A'}`,
    '',
    '## 稳定性指标通过率',
    '',
    '| 指标代码 | 名称 | 通过 | 未通过 | 通过率 |',
    '|---|---|---:|---:|---:|',
    gateSafetyRows || '| none | none | 0 | 0 | 0% |',
    '',
    '## 风险类型分布',
    '',
    '| 风险类型 | 数量 |',
    '|---|---:|',
    failureRows || '| none | 0 |',
    '',
    '## 样本诊断：业务解释 / 关键指标 / 修复方案',
    '',
    '| 样本 ID | 严重度 | 风险分 | 风险类型 | 业务解释 | 关键指标 | 修复方案 |',
    '|---|---|---:|---|---|---|---|',
    topRows || '| none | 稳定 | 0 | 稳定 | 当前无风险样本 | 七类指标通过 | 保持当前窗口 |',
    '',
    '## 交付建议',
    '',
    '- 先用 Top Risk 样本开研发复盘会，不要从全量平均值开始。',
    '- 对主要风险类型建立专项修复路径，并保留修复前后的同口径数据。',
    '- 如果提供 actual_failure 标签，下一步进入冻结参数盲测，验证 HFCD 对历史失效的提前预警能力。',
    '- 如果客户能提供物理参数、工艺参数、边界条件和数字孪生空间，可直接进入 hfcd-field-v1 完整场仿真，比较多条研发路线的长期轨迹。',
    '',
    '## 运行边界',
    '',
    '当前报告先完成稳定性审计：系统将客户行业数据转换为七类稳定性指标，输出稳定状态、风险类型、高风险样本和研发修复方案。工作台和 API 已支持 hfcd-field-v1 完整场仿真：客户补充物理参数、工艺参数、边界条件和数字孪生输入后，系统会生成多步轨迹、候选研发路线、推荐方案、收敛评分和可信度。',
    '',
  ].join('\n');
}
