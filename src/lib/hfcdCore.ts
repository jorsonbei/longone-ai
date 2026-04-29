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
  actual_failure?: number | null;
}

export interface HFCDTemplateField {
  key: string;
  label: string;
  required: boolean;
  description: string;
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

export const HFCD_THRESHOLDS: HFCDGates = {
  Q_error: 0.01,
  energy_drift_per_q: 0.05,
  cavity_peak_ratio: 0.85,
  peak_ratio: 1.0,
  radius_ratio: 1.3,
  manifest_fraction: 0.8,
  buffer_score: 0.5,
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

  return {
    missingRequired,
    availableFields,
    computableFields,
    suggestedFields,
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

export function auditRecord(row: Record<string, unknown>, industry: HFCDIndustry): HFCDAuditResult {
  const gates = ADAPTERS[industry](row);
  const status = evaluateGates(gates);
  const failureMode = classifyFailure(gates, status);
  const actualFailure = safeNumber(row, 'actual_failure');
  return {
    sample_id: String(row.sample_id || 'unknown_sample'),
    gates,
    gate_status: status,
    strict_stable: isStrictStable(status),
    loose_stable: isLooseStable(status),
    failure_mode: failureMode,
    risk_score: round(1 - Object.values(status).filter(Boolean).length / 7),
    repair_plan: planRepair(industry, failureMode),
    actual_failure: actualFailure === undefined ? null : actualFailure,
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

export function validateBlindMetrics(results: HFCDAuditResult[]): HFCDValidationSummary {
  const labeled = results
    .map((result) => ({
      score: result.risk_score,
      label: result.actual_failure === 1 ? 1 : result.actual_failure === 0 ? 0 : null,
    }))
    .filter((item): item is { score: number; label: 0 | 1 } => item.label !== null);

  const positives = labeled.filter((item) => item.label === 1);
  const negatives = labeled.filter((item) => item.label === 0);
  let auc: number | null = null;

  if (positives.length > 0 && negatives.length > 0) {
    let wins = 0;
    positives.forEach((positive) => {
      negatives.forEach((negative) => {
        if (positive.score > negative.score) wins += 1;
        if (positive.score === negative.score) wins += 0.5;
      });
    });
    auc = round(wins / (positives.length * negatives.length), 4);
  }

  const topCount = Math.max(1, Math.ceil(labeled.length * 0.1));
  const topRisk = [...labeled].sort((a, b) => b.score - a.score).slice(0, topCount);
  const precisionTop10 = topRisk.length ? round(topRisk.filter((item) => item.label === 1).length / topRisk.length, 4) : null;
  const failureRate = labeled.length ? round(positives.length / labeled.length, 4) : null;

  return {
    sampleCount: results.length,
    hasActualFailure: labeled.length > 0,
    auc,
    precisionTop10,
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
  const topRisk = [...results].sort((a, b) => b.risk_score - a.risk_score).slice(0, 10);
  const failureRows = Object.entries(summary.failureModeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([mode, count]) => `| ${mode} | ${count} |`)
    .join('\n');
  const topRows = topRisk
    .map(
      (result) =>
        `| ${result.sample_id} | ${result.risk_score} | ${result.failure_mode} | ${result.strict_stable ? 'yes' : 'no'} | ${result.repair_plan} |`,
    )
    .join('\n');

  return [
    `# ${projectName || 'HFCD 稳定窗审计报告'}`,
    '',
    `行业：${spec.title}`,
    '',
    '## 总览',
    '',
    `- 样本数：${summary.sampleCount}`,
    `- strict stable：${summary.strictStableCount}`,
    `- loose stable：${summary.looseStableCount}`,
    `- 高风险样本：${summary.highRiskCount}`,
    `- 主要 FailureMode：${summary.primaryFailureMode}`,
    `- 平均风险分：${summary.averageRiskScore}`,
    '',
    '## 盲测指标',
    '',
    `- actual_failure 标签：${validation.hasActualFailure ? '已检测' : '未提供'}`,
    `- AUC：${validation.auc ?? 'N/A'}`,
    `- precision@top10%：${validation.precisionTop10 ?? 'N/A'}`,
    '',
    '## FailureMode 分布',
    '',
    '| FailureMode | Count |',
    '|---|---:|',
    failureRows || '| none | 0 |',
    '',
    '## Top Risk 样本',
    '',
    '| sample_id | risk_score | FailureMode | strict stable | repair_plan |',
    '|---|---:|---|---|---|',
    topRows || '| none | 0 | stable | yes | N/A |',
    '',
    '## 运行边界',
    '',
    '第一阶段运行的是 HFCD Stability-Window Audit：系统将客户行业数据映射到七个稳定门，输出稳定窗、FailureMode、风险样本和研发修复方案。它不是完整 V12.x 场动力学仿真；深度仿真需要更多物理参数、工艺参数、边界条件和数字孪生输入。',
    '',
  ].join('\n');
}
