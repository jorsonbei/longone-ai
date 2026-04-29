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

export const HFCD_THRESHOLDS: HFCDGates = {
  Q_error: 0.01,
  energy_drift_per_q: 0.05,
  cavity_peak_ratio: 0.85,
  peak_ratio: 1.0,
  radius_ratio: 1.3,
  manifest_fraction: 0.8,
  buffer_score: 0.5,
};

export const HFCD_GATE_EXPLANATIONS: Record<
  keyof HFCDGates,
  { label: string; businessMeaning: string; safeRule: string }
> = {
  Q_error: {
    label: 'Q 核身份误差',
    businessMeaning: '系统核心身份是否还保持住。量子芯片里对应相干身份，新材料里对应相身份，电池里对应 SOH，生命科学里对应细胞身份。',
    safeRule: 'Q_error <= 0.01',
  },
  energy_drift_per_q: {
    label: '单位 Q 能量漂移',
    businessMeaning: '系统是否被过驱动、过热、过载或出现能量账本失衡。',
    safeRule: 'energy_drift_per_q <= 0.05',
  },
  cavity_peak_ratio: {
    label: '承载腔/核心峰比',
    businessMeaning: '环境和结构是否足以承载核心输出。承载不足时，系统看似还能运行，但很容易坍缩。',
    safeRule: 'cavity_peak_ratio >= 0.85',
  },
  peak_ratio: {
    label: '核心峰值保持',
    businessMeaning: '核心性能是否仍有足够峰值，不只是活着，而是还能稳定输出。',
    safeRule: 'peak_ratio >= 1.00',
  },
  radius_ratio: {
    label: '半径局域度',
    businessMeaning: '风险是否向外扩散。半径越大，说明失效、串扰、裂纹、退化或异质性正在外溢。',
    safeRule: 'radius_ratio <= 1.30',
  },
  manifest_fraction: {
    label: '显化达成率',
    businessMeaning: '实验、生产或任务是否真正落成。它衡量系统从“看起来可行”到“实际交付”的比例。',
    safeRule: 'manifest_fraction >= 0.80',
  },
  buffer_score: {
    label: '缓冲余量',
    businessMeaning: '系统还有没有抗扰动余量。缓冲掉到底后，轻微扰动也会触发失稳。',
    safeRule: 'buffer_score >= 0.50',
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
      plainMeaning: '量子比特从激发态回落前能保持多久，是 Q 核身份是否稳住的关键指标。',
      goodRange: '越接近或高于 T1_ref_us 越好',
      riskSignal: 'T1 明显低于参考值会推高 Q_error，表示 Q 核身份退化。',
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
      riskSignal: '参考值缺失会降低 Q 核漂移判断精度。',
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
      riskSignal: '2Q error 上升会同时推高能量漂移并压低核心峰值。',
    },
    readout_error: {
      unit: 'ratio',
      direction: 'lower_is_better',
      hfcdGate: 'cavity_peak_ratio',
      plainMeaning: '读出错误率，反映测量链路是否能承载并识别核心状态。',
      goodRange: '<= 0.01 为优秀区',
      riskSignal: '读出错误上升会削弱 cavity_peak_ratio，并拖累显化结果。',
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
      plainMeaning: '泄漏率反映量子态是否逃出计算子空间，是 Q 核身份破损的强信号。',
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
      plainMeaning: '距离上次校准越久，系统缓冲余量越容易被消耗。',
      goodRange: '<= 24 小时较稳',
      riskSignal: '校准年龄过高会压低 buffer_score，进入 buffer_decay。',
    },
    job_success_rate: {
      unit: 'ratio',
      direction: 'higher_is_better',
      hfcdGate: 'manifest_fraction',
      plainMeaning: '任务成功率是系统是否真正落盘交付的显化指标。',
      goodRange: '>= 0.80 为显化门安全线',
      riskSignal: '成功率低于 0.80 会触发 manifest_underthreshold。',
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
    phase_purity: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'Q_error', plainMeaning: '目标相纯度，决定材料 Q 核身份是否稳定。', goodRange: '>= 0.95 更稳', riskSignal: '相纯度下降会触发 Q_loss。' },
    defect_density_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'radius_ratio', plainMeaning: '缺陷密度，越高越容易让失效半径外扩。', goodRange: '<= 0.10 更稳', riskSignal: '缺陷扩散会触发 de_localized。' },
    crack_length_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'radius_ratio', plainMeaning: '裂纹长度，反映结构风险是否已经传播。', goodRange: '<= 0.10 更稳', riskSignal: '裂纹扩展会推高 radius_ratio。' },
    stress_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'energy_drift_per_q', plainMeaning: '热/机械应力，反映工艺是否过驱动。', goodRange: '<= 0.30 更稳', riskSignal: '应力过高会触发 energy_surplus_overflow。' },
    microstructure_support: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'cavity_peak_ratio', plainMeaning: '微结构承载支持度，决定性能峰值能不能被结构接住。', goodRange: '>= 0.85 更稳', riskSignal: '承载不足会触发 cavity_underfill。' },
    property_retention: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'peak_ratio', plainMeaning: '性能保持率，反映核心峰值是否保住。', goodRange: '>= 0.90 更稳', riskSignal: '保持率下降会触发 core_decay 或 manifest_underthreshold。' },
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
    cell_identity: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'Q_error', plainMeaning: '细胞身份保持度，决定生物系统 Q 核是否还稳定。', goodRange: '>= 0.95 更稳', riskSignal: '身份漂移会触发 Q_loss。' },
    viability: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'peak_ratio', plainMeaning: '活率，反映系统还能不能维持有效输出。', goodRange: '>= 0.90 更稳', riskSignal: '活率下降会触发 core_decay。' },
    productivity_retention: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'peak_ratio', plainMeaning: '产量保持率，反映核心输出是否持续。', goodRange: '>= 0.90 更稳', riskSignal: '产量下滑会压低 peak_ratio 和 manifest_fraction。' },
    metabolic_load_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'energy_drift_per_q', plainMeaning: '代谢负载，反映系统是否被过度喂养或压力过高。', goodRange: '<= 0.25 更稳', riskSignal: '代谢负载过高会触发 energy_surplus_overflow。' },
    heterogeneity_norm: { unit: '0-1', direction: 'lower_is_better', hfcdGate: 'radius_ratio', plainMeaning: '异质性扩散，反映细胞状态是否分叉外溢。', goodRange: '<= 0.15 更稳', riskSignal: '异质性上升会触发 de_localized。' },
    culture_support: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'cavity_peak_ratio', plainMeaning: '培养环境支持度，决定细胞系统能否被环境稳定承载。', goodRange: '>= 0.85 更稳', riskSignal: '培养支持不足会触发 cavity_underfill。' },
    stress_reserve: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'buffer_score', plainMeaning: '压力恢复余量，决定系统被扰动后能不能回到稳定窗。', goodRange: '>= 0.50 为安全线', riskSignal: '余量不足会触发 buffer_decay。' },
    CQA_pass_fraction: { unit: 'ratio', direction: 'higher_is_better', hfcdGate: 'manifest_fraction', plainMeaning: '关键质量属性达标比例，反映最终质量是否真正显化。', goodRange: '>= 0.80 为安全线', riskSignal: 'CQA 不达标会触发 manifest_underthreshold。' },
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
  stable: 'stable',
  Q_loss: 'Q_loss',
  radius_induced_Q_loss: 'radius_induced_Q_loss',
  manifest_underthreshold: 'manifest_underthreshold',
  cavity_underfill: 'cavity_underfill',
  core_decay: 'core_decay',
  de_localized: 'de_localized',
  high_peak_radius_outlier: 'high_peak_radius_outlier',
  energy_surplus_overflow: 'energy_surplus_overflow',
  ultra_micro_energy_surplus: 'ultra_micro_energy_surplus',
  buffer_decay: 'buffer_decay',
  unknown_boundary: 'unknown_boundary',
};

export const BASE_REPAIR_PLANS: Record<HFCDFailureMode, string> = {
  stable: '保持当前窗口；进入下一轮 replay / blind confirmation。',
  Q_loss: '启动 Q-centered recenter；保护相位动量；避免全局粗暴阻尼。',
  radius_induced_Q_loss: '优先执行 Radius-Q coupling guard；先压回扩散半径，再检查 Q identity。',
  manifest_underthreshold: '引入 seed-hold / adaptive anchor；先恢复显化门，不盲目扩大其它参数。',
  cavity_underfill: '执行 CavityReconcile / cavity persistence；提高承载腔而不推高 Cpot 成本。',
  core_decay: '执行 core floor balanced；提升核心峰值但限制 energy overflow。',
  de_localized: '执行 late radius relocalization；作用于 outer shell / radial momentum，保护 Q 和 phase。',
  high_peak_radius_outlier: '执行 peak-radius cap；限制高峰值撑大半径，同时保持 peak >= 1.0。',
  energy_surplus_overflow: '拆分 phase/self/cavity/source ledger；执行 energy micro-closure + negative buffer floor。',
  ultra_micro_energy_surplus: '执行 ultra-micro energy trim；目标 E/Q 0.0492~0.0497；保护 Q/radius/peak/cavity。',
  buffer_decay: '执行 negative buffer floor；恢复 E_self/E_neg 驻留，避免 peak 过冲。',
  unknown_boundary: '进行人工复核，并生成新的 FailureMode 子类。',
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

export function evaluateGates(gates: HFCDGates): HFCDGateStatus {
  return {
    Q_safe: gates.Q_error <= HFCD_THRESHOLDS.Q_error,
    E_safe: gates.energy_drift_per_q <= HFCD_THRESHOLDS.energy_drift_per_q,
    C_safe: gates.cavity_peak_ratio >= HFCD_THRESHOLDS.cavity_peak_ratio,
    P_safe: gates.peak_ratio >= HFCD_THRESHOLDS.peak_ratio,
    R_safe: gates.radius_ratio <= HFCD_THRESHOLDS.radius_ratio,
    M_safe: gates.manifest_fraction >= HFCD_THRESHOLDS.manifest_fraction,
    B_safe: gates.buffer_score >= HFCD_THRESHOLDS.buffer_score,
  };
}

export function isStrictStable(status: HFCDGateStatus) {
  return Object.values(status).every(Boolean);
}

export function isLooseStable(status: HFCDGateStatus) {
  return status.Q_safe && status.C_safe && status.P_safe && status.M_safe;
}

export function classifyFailure(gates: HFCDGates, status: HFCDGateStatus): HFCDFailureMode {
  if (isStrictStable(status)) return 'stable';
  if (!status.Q_safe) {
    return gates.radius_ratio > HFCD_THRESHOLDS.radius_ratio ? 'radius_induced_Q_loss' : 'Q_loss';
  }
  if (!status.M_safe) return 'manifest_underthreshold';
  if (!status.C_safe) return 'cavity_underfill';
  if (!status.P_safe) return 'core_decay';
  if (!status.R_safe) return gates.peak_ratio > 1.45 ? 'high_peak_radius_outlier' : 'de_localized';
  if (!status.E_safe) {
    if (
      gates.energy_drift_per_q <= 0.053 &&
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
  stable: '该样本处于严格稳定窗内，可作为当前批次的基准窗口继续 replay、复测或盲测确认。',
  Q_loss: '核心身份已经出现退化。系统不是单点参数小波动，而是 Q 核本身正在丢失稳定性。',
  radius_induced_Q_loss: '风险半径外扩已经反向拖垮 Q 核身份。先收半径，再修核心。',
  manifest_underthreshold: '系统能量和结构看似还在，但实际交付/达标比例不足，已经卡在显化门。',
  cavity_underfill: '承载腔不足。核心输出没有被环境或结构接住，继续加能量只会提高失稳概率。',
  core_decay: '核心峰值不足。系统还没完全崩，但关键性能已经低于稳定输出线。',
  de_localized: '风险正在外扩。局部问题已经变成半径扩散问题，需要做局域化收束。',
  high_peak_radius_outlier: '核心峰值很强但半径被撑大，属于高输出带来的外溢风险。',
  energy_surplus_overflow: '能量账本过热或过驱动。系统不是缺能量，而是能量没有闭合。',
  ultra_micro_energy_surplus: '系统已经接近稳定窗，只剩极微能量盈余，需要微调而不是重做。',
  buffer_decay: '缓冲余量不足。当前状态可能还能跑，但抗扰动能力已经被消耗。',
  unknown_boundary: '该样本落在未知边界，需要人工复核并沉淀新的 FailureMode 子类。',
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
      : ['七门全部通过'];
  const failedText = failedGates.length
    ? failedGates.map((gate) => formatGateValue(gates, gate)).join('；')
    : '七个稳定门全部通过。';
  const businessSummary =
    failureMode === 'stable'
      ? FAILURE_BUSINESS_MEANING.stable
      : `${FAILURE_BUSINESS_MEANING[failureMode]} 当前风险分 ${riskScore}，严重度判定为“${severity}”。`;
  const hfcdSummary = `HFCD 判定：${failedText}`;
  const repairSummary =
    failureMode === 'stable'
      ? '保持当前窗口，不做大幅参数改动；把该样本作为稳定参照，进入 replay、盲测确认或下一轮更长程验证。'
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

export function auditRecord(row: Record<string, unknown>, industry: HFCDIndustry): HFCDAuditResult {
  const gates = ADAPTERS[industry](row);
  const status = evaluateGates(gates);
  const failureMode = classifyFailure(gates, status);
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

export function auditRecords(rows: Array<Record<string, unknown>>, industry: HFCDIndustry) {
  return rows.map((row) => auditRecord(row, industry));
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
  const executiveConclusion =
    summary.highRiskCount > 0
      ? `本批数据已经出现 ${summary.highRiskCount} 个高风险样本，主失效模式为 ${summary.primaryFailureMode}。建议先处理 Top Risk 样本，再做全批次参数收束。`
      : summary.strictStableCount === summary.sampleCount && summary.sampleCount > 0
        ? '本批数据整体处于严格稳定窗，可作为当前阶段的基准窗口进入 replay、盲测或更长程验证。'
        : `本批数据处于临界状态，主失效模式为 ${summary.primaryFailureMode}。建议优先修复未通过的稳定门，再扩大样本验证。`;
  const failureRows = Object.entries(summary.failureModeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([mode, count]) => `| ${tableCell(mode)} | ${count} |`)
    .join('\n');
  const fieldRows = fieldProfiles
    .map(
      (field) =>
        `| ${field.key} | ${tableCell(field.label)} | ${tableCell(field.unit || '-')} | ${tableCell(field.goodRange || '-')} | ${tableCell(field.hfcdGate || '-')} | ${tableCell(field.plainMeaning || field.description)} | ${tableCell(field.riskSignal || '-')} |`,
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
        `| ${tableCell(result.sample_id)} | ${result.readable.severity} | ${result.risk_score} | ${result.failure_mode} | ${tableCell(result.readable.businessSummary)} | ${tableCell(result.readable.hfcdSummary)} | ${tableCell(result.readable.repairSummary)} |`,
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
    '本报告采用 HFCD Stability-Window Audit：把行业数据映射到七个稳定门，输出业务风险解释、HFCD 变量证据和研发修复方案。它适合客户初筛、历史数据盲测和研发复盘。',
    '',
    '## 关键指标',
    '',
    `- 样本数：${summary.sampleCount}`,
    `- strict stable：${summary.strictStableCount}`,
    `- loose stable：${summary.looseStableCount}`,
    `- 高风险样本：${summary.highRiskCount}`,
    `- 主要 FailureMode：${summary.primaryFailureMode}`,
    `- 平均风险分：${summary.averageRiskScore}`,
    '',
    '## 七门稳定窗解释',
    '',
    '| HFCD Gate | 人话名称 | 安全线 | 业务意义 |',
    '|---|---|---|---|',
    gateRows,
    '',
    '## 字段体检与解释',
    '',
    '| 字段 | 名称 | 单位 | 推荐区间 | 影响 HFCD 门 | 用户要怎么理解 | 风险信号 |',
    '|---|---|---|---|---|---|---|',
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
    '## Gate 安全统计',
    '',
    '| HFCD Gate | 人话名称 | Safe | Fail | Safe Rate |',
    '|---|---|---:|---:|---:|',
    gateSafetyRows || '| none | none | 0 | 0 | 0% |',
    '',
    '## FailureMode 分布',
    '',
    '| FailureMode | Count |',
    '|---|---:|',
    failureRows || '| none | 0 |',
    '',
    '## 样本诊断：业务解释 / HFCD 变量 / 修复方案',
    '',
    '| sample_id | 严重度 | risk_score | FailureMode | 业务解释 | HFCD 变量 | 修复方案 |',
    '|---|---|---:|---|---|---|---|',
    topRows || '| none | 稳定 | 0 | stable | 当前无风险样本 | 七门通过 | 保持当前窗口 |',
    '',
    '## 交付建议',
    '',
    '- 先用 Top Risk 样本开研发复盘会，不要从全量平均值开始。',
    '- 对主 FailureMode 建立专项修复路径，并保留修复前后的同口径数据。',
    '- 如果提供 actual_failure 标签，下一步进入冻结参数盲测，验证 HFCD 对历史失效的提前预警能力。',
    '- 如果客户能提供物理参数、工艺参数、边界条件和数字孪生空间，再进入 HFCD Simulation Mode。',
    '',
    '## 运行边界',
    '',
    '第一阶段运行的是 HFCD Stability-Window Audit：系统将客户行业数据映射到七个稳定门，输出稳定窗、FailureMode、风险样本和研发修复方案。它不是完整 V12.x 场动力学仿真；深度仿真需要更多物理参数、工艺参数、边界条件和数字孪生输入。',
    '',
  ].join('\n');
}
