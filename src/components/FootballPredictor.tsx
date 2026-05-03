import React from 'react';
import { RefreshCw, Search, ShieldAlert, Trophy, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Locale } from '../lib/locale';
import { FOOTBALL_ACCURACY_FEED } from '../lib/generated/footballAccuracyFeed';

type Recommendation = {
  original_status?: string | null;
  status: string;
  accuracy_mode?: boolean;
  recommendation_type?: string;
  model_version?: string;
  accuracy_grade?: 'A' | 'B' | 'C' | string | null;
  predicted_result?: string | null;
  historical_hit_rate?: number | null;
  rolling_hit_rate?: number | null;
  baseline_hit_rate?: number | null;
  hit_rate_lift?: number | null;
  brier_score?: number | null;
  log_loss?: number | null;
  calibration_error?: number | null;
  model_agreement?: number | null;
  prediction_confidence?: number | null;
  confidence_level?: string | null;
  failure_risk?: string | null;
  accuracy_official?: boolean;
  market_family?: string | null;
  market: string;
  selection: string;
  model_prob?: number | null;
  market_prob?: number | null;
  edge?: number | null;
  odds?: number | null;
  stability_score?: number | null;
  confidence?: string | null;
  recommended_platform?: string | null;
  odds_provider?: string | null;
  odds_source_label?: string | null;
  odds_source_url?: string | null;
  preferred_odds_provider?: string | null;
  preferred_odds_url?: string | null;
  odds_source_warning?: string | null;
  price_source?: string | null;
  failure_mode?: string | null;
  reject_reason?: string | null;
  risk_notes?: string[];
};

type MatchItem = {
  event_id: string;
  competition: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  prediction_state: 'official_available' | 'watchlist_available' | 'no_strong_signal';
  top_recommendation?: Recommendation | null;
  recommendations: Recommendation[];
  all_candidate_count: number;
  refresh_context?: {
    hours_to_kickoff?: number | null;
    refresh_priority?: string;
    suggested_refresh_minutes?: number;
    upgrade_potential?: string;
    tracking_note?: string;
  };
};

type Parlay = {
  parlay_id: string;
  accuracy_mode?: boolean;
  recommendation_type?: string;
  model_version?: string;
  legs: number;
  combo_score?: number | null;
  average_model_prob?: number | null;
  average_historical_hit_rate?: number | null;
  average_model_agreement?: number | null;
  average_calibration_error?: number | null;
  combined_odds?: number | null;
  model_hit_prob?: number | null;
  estimated_ev?: number | null;
  min_stability?: number | null;
  risk_level: string;
  note: string;
  legs_detail: Array<{
    event_id: string;
    commence_time?: string | null;
    match_date?: string | null;
    competition?: string | null;
    match: string;
    market: string;
    selection: string;
    predicted_result?: string | null;
    model_prob?: number | null;
    historical_hit_rate?: number | null;
    rolling_hit_rate?: number | null;
    baseline_hit_rate?: number | null;
    hit_rate_lift?: number | null;
    brier_score?: number | null;
    calibration_error?: number | null;
    model_agreement?: number | null;
    prediction_confidence?: number | null;
    accuracy_grade?: string | null;
    confidence_level?: string | null;
    failure_risk?: string | null;
    odds?: number | null;
    platform?: string | null;
    price_source?: string | null;
    odds_provider?: string | null;
    odds_source_label?: string | null;
    odds_source_url?: string | null;
    preferred_odds_provider?: string | null;
    preferred_odds_url?: string | null;
    odds_source_warning?: string | null;
  }>;
};

type Feed = {
  generated_at: string;
  version: string;
  disclaimer?: string;
  odds_source_policy?: {
    preferred_provider?: string;
    preferred_url?: string;
    official_requires_odds?: boolean;
    note?: string;
  };
  summary: {
    fixtures: number;
    raw_fixtures?: number;
    expired_filtered?: number;
    current_fixtures?: number;
    matches_with_official: number;
    matches_with_watchlist: number;
    matches_without_signal: number;
    critical_pre_match?: number;
    high_pre_match?: number;
    upgrade_candidates?: number;
    parlay_candidates: number;
  };
  supported_competitions: string[];
  matches: MatchItem[];
  parlays: Parlay[];
  prediction_history?: Array<{
    recorded_at?: string;
    generated_at?: string;
    reason?: string;
    mode?: string;
    fixtures_current?: number;
    fixtures_raw?: number;
    expired_filtered?: number;
    official?: number;
    watchlist?: number;
    no_signal?: number;
    parlay_candidates?: number;
  }>;
};

type SummaryMode = 'all' | 'official' | 'watchlist' | 'parlay';

const FOOTBALL_COPY = {
  zh: {
    badge: '准确率优先预测模式',
    title: '足球高置信预测',
    intro:
      '读取服务器生成的真实比赛数据，重点看预测概率、历史命中率、Brier、log-loss、校准稳定性和模型一致性。赔率只作为参考特征，不再决定是否进入高置信预测。',
    refresh: '刷新页面数据',
    totalMatches: '总比赛',
    official: '高置信预测',
    watchlist: '观察预测',
    parlays: '高准确率组合',
    clickHint: '点击查看详情',
    matchList: '比赛列表',
    generated: '最后生成',
    version: '版本',
    searchPlaceholder: '搜索球队或联赛',
    allStatus: '全部状态',
    officialState: '高置信',
    watchState: '观察预测',
    noSignalState: '暂无高置信',
    officialDetail: '概率、历史命中率、校准稳定性和模型一致性达到高置信预测门槛。',
    watchDetail: '有预测信号，但概率、命中率、校准或一致性还没有全部达标。',
    noSignalDetail: '当前模型不足以给出高置信结果预测。',
    noMatches: '没有匹配的比赛。',
    loadFailed: '读取失败',
    selectMatch: '选择一场比赛查看模型建议。',
    matchSignal: '比赛信号',
    kickoff: '开赛',
    candidates: '候选',
    platform: '平台',
    state: '状态',
    modelProb: '模型概率',
    marketProb: '市场概率(参考)',
    stability: '模型一致性',
    odds: '赔率(参考)',
    noStrongRec: '这场暂时没有可展示的高置信预测，建议等待伤停、首发或临场数据更新。',
    rejectReason: '未进入高置信原因',
    refreshAdvice: '刷新建议',
    defaultTrackingNote: '临近开赛前建议刷新一次数据。',
    parlayCandidates: '高准确率组合',
    combinedOdds: '组合评分',
    hitProb: '平均模型概率',
    minStability: '平均校准稳定',
    noParlays: '暂无高准确率组合。',
    summaryAllTitle: '全部比赛',
    summaryAllBody: '当前列表显示全部比赛。点击高置信预测、观察预测或高准确率组合，可直接查看对应详情。',
    summaryOfficialTitle: '高置信预测详情',
    summaryOfficialBody: '这些比赛已通过准确率优先门槛。下面列出具体场次、预测市场、预测结果、模型概率、历史命中率、Brier 和校准误差。',
    summaryWatchTitle: '观察预测详情',
    summaryWatchBody: '这些比赛有可跟踪预测信号，但概率、历史命中率、校准或模型一致性还未全部达标。',
    summaryParlayTitle: '高准确率组合详情',
    summaryParlayBody: '下面列出每组组合包含哪几场、预测结果、模型概率、历史命中率、校准误差和风险等级。',
    viewMatch: '预测',
    legs: '串',
    market: '市场',
    selection: '选择',
  },
  en: {
    badge: 'Accuracy-First Prediction Mode',
    title: 'High-Confidence Football Predictions',
    intro:
      'Read the real match feed generated by the server. The main gates are prediction probability, historical hit rate, Brier, log-loss, calibration stability, and model agreement. Odds are reference features only and no longer decide official predictions.',
    refresh: 'Refresh data',
    totalMatches: 'Total matches',
    official: 'High-confidence predictions',
    watchlist: 'Watch predictions',
    parlays: 'Accuracy combos',
    clickHint: 'Click for details',
    matchList: 'Match list',
    generated: 'Generated',
    version: 'Version',
    searchPlaceholder: 'Search team or league',
    allStatus: 'All status',
    officialState: 'High confidence',
    watchState: 'Watch prediction',
    noSignalState: 'No high-confidence signal',
    officialDetail: 'Probability, historical hit rate, calibration, and model agreement pass the high-confidence gate.',
    watchDetail: 'There is a prediction signal, but probability, accuracy, calibration, or agreement is not fully qualified yet.',
    noSignalDetail: 'The model does not have enough confidence for a high-confidence result prediction.',
    noMatches: 'No matching matches.',
    loadFailed: 'Load failed',
    selectMatch: 'Select a match to view model signals.',
    matchSignal: 'Match signal',
    kickoff: 'Kickoff',
    candidates: 'Candidates',
    platform: 'Platform',
    state: 'State',
    modelProb: 'Model prob',
    marketProb: 'Market prob (ref)',
    stability: 'Model agreement',
    odds: 'Odds (ref)',
    noStrongRec: 'No high-confidence prediction yet. Refresh near kickoff for injuries, lineups, or live context.',
    rejectReason: 'Not high-confidence because',
    refreshAdvice: 'Refresh advice',
    defaultTrackingNote: 'Refresh once near kickoff.',
    parlayCandidates: 'Accuracy combos',
    combinedOdds: 'Combo score',
    hitProb: 'Avg model prob',
    minStability: 'Avg calibration',
    noParlays: 'No accuracy combos.',
    summaryAllTitle: 'All matches',
    summaryAllBody: 'The list currently shows all matches. Click high-confidence predictions, watch predictions, or accuracy combos to open details.',
    summaryOfficialTitle: 'High-confidence prediction details',
    summaryOfficialBody: 'These matches pass the accuracy-first gate. Details include match, market, predicted result, model probability, historical hit rate, Brier, and calibration error.',
    summaryWatchTitle: 'Watch prediction details',
    summaryWatchBody: 'These matches have trackable prediction signals, but probability, historical accuracy, calibration, or model agreement is not fully qualified.',
    summaryParlayTitle: 'Accuracy combo details',
    summaryParlayBody: 'Each combo shows the legs, predicted result, model probability, historical hit rate, calibration error, and risk level.',
    viewMatch: 'Predict',
    legs: 'legs',
    market: 'Market',
    selection: 'Selection',
  },
};

const FOOTBALL_COPY_BY_LOCALE: Record<Locale, typeof FOOTBALL_COPY.en> = {
  en: FOOTBALL_COPY.en,
  zh: FOOTBALL_COPY.zh,
  fr: {
    badge: 'HFCD Football OS',
    title: 'Prédictions football haute confiance',
    intro:
      'Mode Accuracy-First : le modèle classe les résultats les plus probables avec probabilité, précision historique, Brier, erreur de calibration et accord du modèle. Les cotes restent une référence, pas une condition de décision.',
    refresh: 'Actualiser les données',
    totalMatches: 'Total matchs',
    official: 'Prédictions haute confiance',
    watchlist: 'À surveiller',
    parlays: 'Combinaisons haute précision',
    clickHint: 'Cliquer pour détails',
    matchList: 'Liste des matchs',
    generated: 'Généré',
    version: 'Version',
    searchPlaceholder: 'Rechercher équipe ou ligue',
    allStatus: 'Tous les statuts',
    officialState: 'Prédiction haute confiance',
    watchState: 'À surveiller',
    noSignalState: 'Pas de signal fort',
    officialDetail: 'Ce match passe le seuil Accuracy-First.',
    watchDetail: 'Signal de prédiction traçable, mais probabilité, précision ou calibration insuffisante.',
    noSignalDetail: 'Le modèle ne dispose pas encore d’un signal de résultat assez stable.',
    noMatches: 'Aucun match correspondant.',
    loadFailed: 'Échec du chargement',
    selectMatch: 'Sélectionnez un match pour voir les signaux du modèle.',
    matchSignal: 'Signal du match',
    kickoff: 'Début',
    candidates: 'Candidats',
    platform: 'Plateforme',
    state: 'Statut',
    modelProb: 'Prob. modèle',
    marketProb: 'Prob. marché (réf.)',
    stability: 'Accord modèle',
    odds: 'Cotes (réf.)',
    noStrongRec: 'Aucune prédiction haute confiance pour l’instant. Actualisez près du coup d’envoi.',
    rejectReason: 'Raison du rejet',
    refreshAdvice: 'Conseil d’actualisation',
    defaultTrackingNote: 'Actualisez une fois près du coup d’envoi.',
    parlayCandidates: 'Combinaisons haute précision',
    combinedOdds: 'Score de combinaison',
    hitProb: 'Prob. modèle moy.',
    minStability: 'Calibration moy.',
    noParlays: 'Aucune combinaison haute précision.',
    summaryAllTitle: 'Tous les matchs',
    summaryAllBody: 'La liste affiche tous les matchs. Cliquez sur prédictions haute confiance, observation ou combinaisons pour voir les détails.',
    summaryOfficialTitle: 'Détails des prédictions haute confiance',
    summaryOfficialBody: 'Ces matchs passent la porte Accuracy-First : match, marché, résultat prévu, probabilité modèle, précision historique, Brier et calibration.',
    summaryWatchTitle: 'Détails des matchs à surveiller',
    summaryWatchBody: 'Ces matchs ont un signal traçable, mais ne passent pas encore les seuils de précision, calibration ou accord modèle.',
    summaryParlayTitle: 'Détails des combinaisons haute précision',
    summaryParlayBody: 'Chaque combinaison indique les matchs, le résultat prévu, la probabilité modèle, la précision historique, la calibration et le risque.',
    viewMatch: 'Prédire',
    legs: 'sélections',
    market: 'Marché',
    selection: 'Sélection',
  },
  es: {
    badge: 'HFCD Football OS',
    title: 'Predicción de fútbol de alta confianza',
    intro:
      'Modo Accuracy-First: el modelo prioriza el resultado más probable usando probabilidad, acierto histórico, Brier, calibración y acuerdo interno. Las cuotas se muestran solo como referencia, no como puerta de decisión.',
    refresh: 'Actualizar datos',
    totalMatches: 'Partidos totales',
    official: 'Predicciones alta confianza',
    watchlist: 'En observación',
    parlays: 'Combinaciones de precisión',
    clickHint: 'Clic para detalles',
    matchList: 'Lista de partidos',
    generated: 'Generado',
    version: 'Versión',
    searchPlaceholder: 'Buscar equipo o liga',
    allStatus: 'Todos los estados',
    officialState: 'Predicción alta confianza',
    watchState: 'En observación',
    noSignalState: 'Sin señal fuerte',
    officialDetail: 'Este partido supera el filtro Accuracy-First.',
    watchDetail: 'Hay señal predictiva, pero probabilidad, acierto histórico, calibración o acuerdo todavía no bastan.',
    noSignalDetail: 'El modelo aún no ve una señal de resultado suficientemente estable.',
    noMatches: 'No hay partidos coincidentes.',
    loadFailed: 'Error al cargar',
    selectMatch: 'Selecciona un partido para ver señales del modelo.',
    matchSignal: 'Señal del partido',
    kickoff: 'Inicio',
    candidates: 'Candidatos',
    platform: 'Plataforma',
    state: 'Estado',
    modelProb: 'Prob. modelo',
    marketProb: 'Prob. mercado (ref.)',
    stability: 'Acuerdo modelo',
    odds: 'Cuotas (ref.)',
    noStrongRec: 'Aún no hay predicción de alta confianza. Actualiza cerca del inicio.',
    rejectReason: 'Motivo de descarte',
    refreshAdvice: 'Consejo de actualización',
    defaultTrackingNote: 'Actualiza una vez cerca del inicio.',
    parlayCandidates: 'Combinaciones de precisión',
    combinedOdds: 'Puntuación combo',
    hitProb: 'Prob. modelo media',
    minStability: 'Calibración media',
    noParlays: 'No hay combinaciones de precisión.',
    summaryAllTitle: 'Todos los partidos',
    summaryAllBody: 'La lista muestra todos los partidos. Haz clic en alta confianza, observación o combinaciones para ver detalles.',
    summaryOfficialTitle: 'Detalles de predicciones alta confianza',
    summaryOfficialBody: 'Estos partidos pasan el filtro Accuracy-First: partido, mercado, resultado previsto, probabilidad modelo, acierto histórico, Brier y calibración.',
    summaryWatchTitle: 'Detalles de observación',
    summaryWatchBody: 'Estos partidos tienen señales, pero aún no pasan los umbrales de precisión, calibración o acuerdo del modelo.',
    summaryParlayTitle: 'Detalles de combinaciones de precisión',
    summaryParlayBody: 'Cada combinación muestra partidos, resultado previsto, probabilidad modelo, acierto histórico, calibración y riesgo.',
    viewMatch: 'Predecir',
    legs: 'selecciones',
    market: 'Mercado',
    selection: 'Selección',
  },
  vi: {
    badge: 'HFCD Football OS',
    title: 'Dự đoán bóng đá độ tin cậy cao',
    intro:
      'Chế độ Accuracy-First: mô hình ưu tiên kết quả có xác suất xảy ra cao nhất dựa trên xác suất mô hình, tỷ lệ trúng lịch sử, Brier, sai số hiệu chuẩn và độ đồng thuận. Tỷ lệ chỉ là tham khảo, không quyết định dự đoán chính.',
    refresh: 'Làm mới dữ liệu',
    totalMatches: 'Tổng số trận',
    official: 'Dự đoán tin cậy cao',
    watchlist: 'Theo dõi',
    parlays: 'Tổ hợp độ chính xác cao',
    clickHint: 'Bấm để xem chi tiết',
    matchList: 'Danh sách trận',
    generated: 'Tạo lúc',
    version: 'Phiên bản',
    searchPlaceholder: 'Tìm đội hoặc giải',
    allStatus: 'Tất cả trạng thái',
    officialState: 'Dự đoán tin cậy cao',
    watchState: 'Theo dõi',
    noSignalState: 'Chưa có tín hiệu mạnh',
    officialDetail: 'Trận này vượt qua cổng Accuracy-First.',
    watchDetail: 'Có tín hiệu dự đoán, nhưng xác suất, lịch sử trúng, hiệu chuẩn hoặc đồng thuận chưa đủ.',
    noSignalDetail: 'Mô hình chưa có tín hiệu kết quả đủ ổn định.',
    noMatches: 'Không có trận phù hợp.',
    loadFailed: 'Tải thất bại',
    selectMatch: 'Chọn một trận để xem tín hiệu mô hình.',
    matchSignal: 'Tín hiệu trận',
    kickoff: 'Giờ đá',
    candidates: 'Ứng viên',
    platform: 'Nền tảng',
    state: 'Trạng thái',
    modelProb: 'Xác suất mô hình',
    marketProb: 'Xác suất thị trường (tham khảo)',
    stability: 'Đồng thuận mô hình',
    odds: 'Tỷ lệ (tham khảo)',
    noStrongRec: 'Chưa có dự đoán tin cậy cao. Hãy làm mới gần giờ đá.',
    rejectReason: 'Lý do chưa nâng cấp',
    refreshAdvice: 'Gợi ý làm mới',
    defaultTrackingNote: 'Nên làm mới một lần gần giờ đá.',
    parlayCandidates: 'Tổ hợp độ chính xác cao',
    combinedOdds: 'Điểm tổ hợp',
    hitProb: 'Xác suất mô hình TB',
    minStability: 'Hiệu chuẩn TB',
    noParlays: 'Chưa có tổ hợp độ chính xác cao.',
    summaryAllTitle: 'Tất cả trận',
    summaryAllBody: 'Danh sách đang hiển thị tất cả trận. Bấm vào dự đoán tin cậy cao, theo dõi hoặc tổ hợp để xem chi tiết.',
    summaryOfficialTitle: 'Chi tiết dự đoán tin cậy cao',
    summaryOfficialBody: 'Các trận này vượt qua cổng Accuracy-First: trận, thị trường, kết quả dự đoán, xác suất mô hình, tỷ lệ trúng lịch sử, Brier và hiệu chuẩn.',
    summaryWatchTitle: 'Chi tiết theo dõi',
    summaryWatchBody: 'Các trận này có tín hiệu, nhưng chưa qua ngưỡng xác suất, hiệu chuẩn hoặc đồng thuận mô hình.',
    summaryParlayTitle: 'Chi tiết tổ hợp độ chính xác cao',
    summaryParlayBody: 'Mỗi tổ hợp hiển thị trận, kết quả dự đoán, xác suất mô hình, tỷ lệ trúng lịch sử, hiệu chuẩn và rủi ro.',
    viewMatch: 'Dự đoán',
    legs: 'lựa chọn',
    market: 'Kèo',
    selection: 'Lựa chọn',
  },
  de: {
    badge: 'HFCD Football OS',
    title: 'Fußball-Prognosen mit hoher Sicherheit',
    intro:
      'Accuracy-First-Modus: Das Modell priorisiert das wahrscheinlichste Ergebnis anhand von Modellwahrscheinlichkeit, historischer Trefferquote, Brier, Kalibrierung und Modellkonsens. Quoten bleiben nur Referenz und kein Entscheidungstor.',
    refresh: 'Daten aktualisieren',
    totalMatches: 'Spiele gesamt',
    official: 'Hohe-Sicherheit-Prognosen',
    watchlist: 'Beobachtung',
    parlays: 'Genauigkeits-Kombinationen',
    clickHint: 'Für Details klicken',
    matchList: 'Spielliste',
    generated: 'Generiert',
    version: 'Version',
    searchPlaceholder: 'Team oder Liga suchen',
    allStatus: 'Alle Status',
    officialState: 'Hohe-Sicherheit-Prognose',
    watchState: 'Beobachtung',
    noSignalState: 'Kein starkes Signal',
    officialDetail: 'Dieses Spiel besteht das Accuracy-First-Gate.',
    watchDetail: 'Ein Prognosesignal ist vorhanden, aber Wahrscheinlichkeit, Historie, Kalibrierung oder Konsens reichen noch nicht.',
    noSignalDetail: 'Das Modell sieht noch kein ausreichend stabiles Ergebnissignal.',
    noMatches: 'Keine passenden Spiele.',
    loadFailed: 'Laden fehlgeschlagen',
    selectMatch: 'Wählen Sie ein Spiel, um Modellsignale zu sehen.',
    matchSignal: 'Spielsignal',
    kickoff: 'Anstoß',
    candidates: 'Kandidaten',
    platform: 'Plattform',
    state: 'Status',
    modelProb: 'Modell-Wahrsch.',
    marketProb: 'Markt-Wahrsch. (Ref.)',
    stability: 'Modellkonsens',
    odds: 'Quote (Ref.)',
    noStrongRec: 'Noch keine Hohe-Sicherheit-Prognose. Kurz vor Anstoß erneut aktualisieren.',
    rejectReason: 'Ablehnungsgrund',
    refreshAdvice: 'Aktualisierungshinweis',
    defaultTrackingNote: 'Kurz vor Anstoß einmal aktualisieren.',
    parlayCandidates: 'Genauigkeits-Kombinationen',
    combinedOdds: 'Kombi-Score',
    hitProb: 'Ø Modell-Wahrsch.',
    minStability: 'Ø Kalibrierung',
    noParlays: 'Keine Genauigkeits-Kombinationen.',
    summaryAllTitle: 'Alle Spiele',
    summaryAllBody: 'Die Liste zeigt alle Spiele. Klicken Sie auf Hohe-Sicherheit, Beobachtung oder Kombinationen für Details.',
    summaryOfficialTitle: 'Details der Hohe-Sicherheit-Prognosen',
    summaryOfficialBody: 'Diese Spiele bestehen das Accuracy-First-Gate: Spiel, Markt, vorhergesagtes Ergebnis, Modellwahrscheinlichkeit, historische Trefferquote, Brier und Kalibrierung.',
    summaryWatchTitle: 'Details Beobachtung',
    summaryWatchBody: 'Diese Spiele haben Signale, bestehen aber noch nicht Wahrscheinlichkeit, Kalibrierung oder Modellkonsens.',
    summaryParlayTitle: 'Details der Genauigkeits-Kombinationen',
    summaryParlayBody: 'Jede Kombination zeigt Spiele, Ergebnis, Modellwahrscheinlichkeit, historische Trefferquote, Kalibrierung und Risiko.',
    viewMatch: 'Prognose',
    legs: 'Auswahlen',
    market: 'Markt',
    selection: 'Auswahl',
  },
  ja: {
    badge: 'HFCD Football OS',
    title: '高信頼サッカー予測',
    intro:
      'Accuracy-First モード：モデル確率、過去的中率、Brier、較正誤差、モデル一致度で最も起こりやすい結果を判定します。オッズは参考表示であり、主要な判定条件ではありません。',
    refresh: 'データ更新',
    totalMatches: '全試合',
    official: '高信頼予測',
    watchlist: '観察候補',
    parlays: '高精度コンボ',
    clickHint: 'クリックで詳細',
    matchList: '試合一覧',
    generated: '生成時刻',
    version: 'バージョン',
    searchPlaceholder: 'チームまたはリーグを検索',
    allStatus: '全ステータス',
    officialState: '高信頼予測',
    watchState: '観察候補',
    noSignalState: '強い信号なし',
    officialDetail: 'この試合は Accuracy-First の判定を通過しています。',
    watchDetail: '予測信号はありますが、確率、過去精度、較正、モデル一致度がまだ不足しています。',
    noSignalDetail: 'モデルはまだ十分に安定した結果信号を検出していません。',
    noMatches: '一致する試合がありません。',
    loadFailed: '読み込み失敗',
    selectMatch: '試合を選ぶとモデル信号を表示します。',
    matchSignal: '試合信号',
    kickoff: '開始',
    candidates: '候補',
    platform: '提供元',
    state: '状態',
    modelProb: 'モデル確率',
    marketProb: '市場確率（参考）',
    stability: 'モデル一致度',
    odds: 'オッズ（参考）',
    noStrongRec: 'まだ高信頼予測はありません。開始前に再更新してください。',
    rejectReason: '未昇格理由',
    refreshAdvice: '更新推奨',
    defaultTrackingNote: '開始前に一度更新してください。',
    parlayCandidates: '高精度コンボ',
    combinedOdds: 'コンボスコア',
    hitProb: '平均モデル確率',
    minStability: '平均較正',
    noParlays: '高精度コンボはありません。',
    summaryAllTitle: '全試合',
    summaryAllBody: '現在は全試合を表示しています。高信頼予測、観察候補、高精度コンボをクリックすると詳細を確認できます。',
    summaryOfficialTitle: '高信頼予測の詳細',
    summaryOfficialBody: 'これらの試合は Accuracy-First 判定を通過しています。試合、マーケット、予測結果、モデル確率、過去的中率、Brier、較正誤差を表示します。',
    summaryWatchTitle: '観察候補の詳細',
    summaryWatchBody: 'これらの試合は追跡信号がありますが、確率、較正、モデル一致度のしきい値をまだ通過していません。',
    summaryParlayTitle: '高精度コンボの詳細',
    summaryParlayBody: '各コンボに含まれる試合、予測結果、モデル確率、過去的中率、較正誤差、リスクを表示します。',
    viewMatch: '予測',
    legs: '選択',
    market: 'マーケット',
    selection: '選択',
  },
};

function copyForLocale(locale?: Locale) {
  return FOOTBALL_COPY_BY_LOCALE[locale || 'en'] || FOOTBALL_COPY.en;
}

function stateCopy(copy: ReturnType<typeof copyForLocale>): Record<MatchItem['prediction_state'], { label: string; tone: string; detail: string }> {
  return {
    official_available: {
      label: copy.officialState,
      tone: 'border-emerald-400/35 bg-emerald-400/10 text-emerald-200',
      detail: copy.officialDetail,
    },
    watchlist_available: {
      label: copy.watchState,
      tone: 'border-amber-300/35 bg-amber-300/10 text-amber-100',
      detail: copy.watchDetail,
    },
    no_strong_signal: {
      label: copy.noSignalState,
      tone: 'border-slate-500/25 bg-slate-500/10 text-slate-300',
      detail: copy.noSignalDetail,
    },
  };
}

function fmtPct(value?: number | null, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtNum(value?: number | null, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return value.toFixed(digits);
}

function footballAccuracyLabels(locale: Locale) {
  if (locale === 'zh') {
    return {
      predictedResult: '预测结果',
      historicalHitRate: '历史命中率',
      rollingHitRate: '滚动命中率',
      baselineHitRate: '基线命中率',
      hitRateLift: '相对基线提升',
      brier: 'Brier',
      logLoss: 'Log-loss',
      calibrationError: '校准误差',
      modelAgreement: '模型一致性',
      predictionConfidence: '预测置信',
      accuracyGrade: '准确率等级',
      failureRisk: '主要风险',
      oddsReference: '赔率仅供参考',
    };
  }
  return {
    predictedResult: 'Predicted result',
    historicalHitRate: 'Historical hit rate',
    rollingHitRate: 'Rolling hit rate',
    baselineHitRate: 'Baseline hit rate',
    hitRateLift: 'Hit-rate lift',
    brier: 'Brier',
    logLoss: 'Log-loss',
    calibrationError: 'Calibration error',
    modelAgreement: 'Model agreement',
    predictionConfidence: 'Prediction confidence',
    accuracyGrade: 'Accuracy grade',
    failureRisk: 'Main risk',
    oddsReference: 'Odds are reference only',
  };
}

function fmtDate(value?: string, locale: Locale = 'zh') {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const TEAM_NAME_ZH: Record<string, string> = {
  '1. FC Heidenheim': '海登海姆',
  '1. FC Köln': '科隆',
  'AC Milan': 'AC米兰',
  'AS Monaco': '摩纳哥',
  'AS Roma': '罗马',
  'AZ Alkmaar': '阿尔克马尔',
  Ajax: '阿贾克斯',
  Alavés: '阿拉维斯',
  Angers: '昂热',
  Arsenal: '阿森纳',
  'Aston Villa': '阿斯顿维拉',
  'Atalanta BC': '亚特兰大',
  'Athletic Bilbao': '毕尔巴鄂竞技',
  'Atlético Madrid': '马德里竞技',
  Augsburg: '奥格斯堡',
  Auxerre: '欧塞尔',
  'Avispa Fukuoka': '福冈黄蜂',
  Barcelona: '巴塞罗那',
  'Bayer Leverkusen': '勒沃库森',
  'Bayern Munich': '拜仁慕尼黑',
  Bologna: '博洛尼亚',
  'Borussia Dortmund': '多特蒙德',
  'Borussia Monchengladbach': '门兴格拉德巴赫',
  Bournemouth: '伯恩茅斯',
  Brentford: '布伦特福德',
  Brest: '布雷斯特',
  'Brighton and Hove Albion': '布莱顿',
  Burnley: '伯恩利',
  'CA Osasuna': '奥萨苏纳',
  Cagliari: '卡利亚里',
  'Celta Vigo': '塞尔塔',
  'Cerezo Osaka': '大阪樱花',
  Chelsea: '切尔西',
  Como: '科莫',
  Cremonese: '克雷莫内塞',
  'Crystal Palace': '水晶宫',
  'Eintracht Frankfurt': '法兰克福',
  'Elche CF': '埃尔切',
  Espanyol: '西班牙人',
  Everton: '埃弗顿',
  Excelsior: 'SBV精英',
  'FC Machida Zelvia': '町田泽维亚',
  'FC St. Pauli': '圣保利',
  'FC Tokyo': 'FC东京',
  'FC Twente Enschede': '特温特',
  'FC Utrecht': '乌德勒支',
  'FC Volendam': '福伦丹',
  'FC Zwolle': '兹沃勒',
  'FSV Mainz 05': '美因茨05',
  'Fagiano Okayama': '冈山绿雉',
  Feyenoord: '费耶诺德',
  Fiorentina: '佛罗伦萨',
  'Fortuna Sittard': '福图纳锡塔德',
  Fulham: '富勒姆',
  'Gamba Osaka': '大阪钢巴',
  Genoa: '热那亚',
  Getafe: '赫塔费',
  Girona: '赫罗纳',
  'Go Ahead Eagles': '前进之鹰',
  Groningen: '格罗宁根',
  'Hamburger SV': '汉堡',
  Heerenveen: '海伦芬',
  'Hellas Verona': '维罗纳',
  'Heracles Almelo': '赫拉克勒斯',
  'Hiroshima Sanfrecce FC': '广岛三箭',
  'Inter Milan': '国际米兰',
  'JEF United Chiba': '千叶市原',
  Juventus: '尤文图斯',
  'Kashima Antlers': '鹿岛鹿角',
  'Kashiwa Reysol': '柏太阳神',
  'Kawasaki Frontale': '川崎前锋',
  'Kyoto Purple Sanga': '京都不死鸟',
  Lazio: '拉齐奥',
  'Le Havre': '勒阿弗尔',
  Lecce: '莱切',
  'Leeds United': '利兹联',
  Levante: '莱万特',
  Lille: '里尔',
  Liverpool: '利物浦',
  Lorient: '洛里昂',
  Lyon: '里昂',
  Mallorca: '马略卡',
  'Manchester City': '曼城',
  'Manchester United': '曼联',
  Marseille: '马赛',
  Metz: '梅斯',
  'Mito HollyHock': '水户蜀葵',
  'NAC Breda': '布雷达',
  'NEC Nijmegen': '奈梅亨',
  'Nagoya Grampus': '名古屋鲸八',
  Nantes: '南特',
  Napoli: '那不勒斯',
  'Newcastle United': '纽卡斯尔联',
  Nice: '尼斯',
  'Nottingham Forest': '诺丁汉森林',
  Oviedo: '奥维耶多',
  'PSV Eindhoven': '埃因霍温',
  'Paris FC': '巴黎FC',
  'Paris Saint Germain': '巴黎圣日耳曼',
  Parma: '帕尔马',
  Pisa: '比萨',
  'RB Leipzig': 'RB莱比锡',
  'RC Lens': '朗斯',
  'Rayo Vallecano': '巴列卡诺',
  'Real Betis': '皇家贝蒂斯',
  'Real Madrid': '皇家马德里',
  'Real Sociedad': '皇家社会',
  Rennes: '雷恩',
  'SC Braga': '布拉加',
  'SC Freiburg': '弗赖堡',
  'SC Telstar': '特尔斯达',
  Sassuolo: '萨索洛',
  Sevilla: '塞维利亚',
  'Shimizu S Pulse': '清水心跳',
  'Sparta Rotterdam': '鹿特丹斯巴达',
  Strasbourg: '斯特拉斯堡',
  Sunderland: '桑德兰',
  'TSG Hoffenheim': '霍芬海姆',
  'Tokyo Verdy': '东京绿茵',
  Torino: '都灵',
  'Tottenham Hotspur': '托特纳姆热刺',
  Toulouse: '图卢兹',
  Udinese: '乌迪内斯',
  'Union Berlin': '柏林联合',
  'Urawa Red Diamonds': '浦和红钻',
  'V-Varen Nagasaki': '长崎成功丸',
  Valencia: '瓦伦西亚',
  'VfB Stuttgart': '斯图加特',
  'VfL Wolfsburg': '沃尔夫斯堡',
  Villarreal: '比利亚雷亚尔',
  'Vissel Kobe': '神户胜利船',
  'Werder Bremen': '云达不莱梅',
  'West Ham United': '西汉姆联',
  'Wolverhampton Wanderers': '狼队',
  'Yokohama F Marinos': '横滨水手',
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localizedTeamName(name: string, locale: Locale) {
  if (locale !== 'zh') return name;
  return TEAM_NAME_ZH[name.trim()] || name;
}

function localizedMatchName(match: MatchItem, locale: Locale) {
  return `${localizedTeamName(match.home_team, locale)} vs ${localizedTeamName(match.away_team, locale)}`;
}

function localizeFootballText(value: string, locale: Locale) {
  if (locale !== 'zh' || !value) return value;
  let next = value;
  Object.entries(TEAM_NAME_ZH)
    .sort(([a], [b]) => b.length - a.length)
    .forEach(([source, translated]) => {
      next = next.replace(new RegExp(escapeRegExp(source), 'g'), translated);
    });
  return next;
}

function recommendationTitle(rec: Recommendation, locale: Locale) {
  const family = rec.market_family ? `${rec.market_family} / ` : '';
  return `${family}${rec.market}：${localizeFootballText(rec.selection, locale)}`;
}

function oddsSourceLabel(rec: Recommendation) {
  return rec.odds_source_label || rec.recommended_platform || '未标注赔率来源';
}

function oddsSourceNode(rec: Recommendation, copy: ReturnType<typeof copyForLocale>) {
  const source = oddsSourceLabel(rec);
  const preferred = rec.preferred_odds_provider || 'Titan007';
  return (
    <>
      {copy.platform}：{source} · 首选复核：
      {rec.preferred_odds_url ? (
        <a className="text-emerald-200 underline-offset-4 hover:underline" href={rec.preferred_odds_url} target="_blank" rel="noreferrer">
          {preferred}
        </a>
      ) : (
        preferred
      )}
    </>
  );
}

function legSourceText(leg: Parlay['legs_detail'][number]) {
  const source = leg.odds_source_label || leg.platform || '未标注赔率来源';
  const preferred = leg.preferred_odds_provider || 'Titan007';
  return `${source}；首选复核 ${preferred}`;
}

function legMetaText(leg: Parlay['legs_detail'][number], copy: ReturnType<typeof copyForLocale>, locale: Locale) {
  const league = leg.competition || '-';
  const date = fmtDate(leg.match_date || leg.commence_time || undefined, locale);
  return `${league} · ${copy.kickoff}：${date}`;
}

function pickDefaultMatch(matches: MatchItem[]) {
  return (
    matches.find((match) => match.prediction_state === 'official_available') ||
    matches.find((match) => match.prediction_state === 'watchlist_available') ||
    matches[0] ||
    null
  );
}

async function fetchFootballFeed(): Promise<Feed> {
  const endpoints = [
    `/api/hfcd/football/simple-predict?t=${Date.now()}`,
    `/api/football/predict?t=${Date.now()}`,
  ];
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) {
        errors.push(`${endpoint}: HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      if (data?.matches && Array.isArray(data.matches)) {
        return data as Feed;
      }
      if (data?.fixtures && Array.isArray(data.fixtures) && data?.parlays) {
        return {
          generated_at: data.generated_at,
          version: data.version,
          summary: data.summary,
          supported_competitions: data.supported_competitions || [],
          matches: data.fixtures.map((fixture: any) => ({
            event_id: fixture.match_id,
            competition: fixture.league,
            commence_time: fixture.kickoff,
            home_team: fixture.home_team,
            away_team: fixture.away_team,
            prediction_state:
              fixture.top_signal?.model_conclusion === 'official_accuracy'
                ? 'official_available'
                : fixture.top_signal?.model_conclusion === 'watchlist'
                  ? 'watchlist_available'
                  : 'no_strong_signal',
            top_recommendation: fixture.top_signal || null,
            recommendations: fixture.top_signal ? [fixture.top_signal] : [],
            all_candidate_count: fixture.candidate_count || 0,
            refresh_context: fixture.refresh_context || null,
          })),
          parlays: data.parlays,
          prediction_history: data.prediction_history || [],
          model_version: data.model_version,
          accuracy_mode: Boolean(data.accuracy_mode),
        } as Feed;
      }
      errors.push(`${endpoint}: invalid feed shape`);
    } catch (error) {
      errors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.warn('Football API failed; using embedded feed.', errors);
  return FOOTBALL_ACCURACY_FEED as unknown as Feed;
}

export function FootballPredictor({ locale = 'zh' }: { locale?: Locale }) {
  const copy = React.useMemo(() => copyForLocale(locale), [locale]);
  const accuracyLabels = React.useMemo(() => footballAccuracyLabels(locale), [locale]);
  const states = React.useMemo(() => stateCopy(copy), [copy]);
  const [feed, setFeed] = React.useState<Feed | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [stateFilter, setStateFilter] = React.useState<'all' | MatchItem['prediction_state']>('all');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [summaryMode, setSummaryMode] = React.useState<SummaryMode>('all');

  const loadFeed = React.useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchFootballFeed();
      setFeed(data);
      setSelectedId((current) => current || pickDefaultMatch(data.matches)?.event_id || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取足球预测数据失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      void loadFeed();
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [loadFeed]);

  const filteredMatches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return (feed?.matches || []).filter((match) => {
      if (stateFilter !== 'all' && match.prediction_state !== stateFilter) return false;
      if (!q) return true;
      return `${match.home_team} ${match.away_team} ${localizedMatchName(match, locale)} ${match.competition}`
        .toLowerCase()
        .includes(q);
    });
  }, [feed?.matches, locale, query, stateFilter]);

  const selectedMatch = React.useMemo(() => {
    if (!feed) return null;
    return feed.matches.find((match) => match.event_id === selectedId) || pickDefaultMatch(feed.matches);
  }, [feed, selectedId]);

  const officialMatches = React.useMemo(
    () => (feed?.matches || []).filter((match) => match.prediction_state === 'official_available'),
    [feed?.matches],
  );

  const watchlistMatches = React.useMemo(
    () => (feed?.matches || []).filter((match) => match.prediction_state === 'watchlist_available'),
    [feed?.matches],
  );

  const predictionHistory = React.useMemo(
    () => [...(feed?.prediction_history || [])].slice(-6).reverse(),
    [feed?.prediction_history],
  );

  const relatedParlays = React.useMemo(() => {
    if (!feed || !selectedMatch) return [];
    const exact = feed.parlays.filter((parlay) =>
      parlay.legs_detail.some((leg) => leg.event_id === selectedMatch.event_id),
    );
    return (exact.length ? exact : feed.parlays).slice(0, 4);
  }, [feed, selectedMatch]);

  const selectFirstMatch = React.useCallback((matches: MatchItem[]) => {
    if (matches[0]) {
      setSelectedId(matches[0].event_id);
    }
  }, []);

  const handleSummaryClick = React.useCallback(
    (mode: SummaryMode) => {
      setSummaryMode(mode);
      if (mode === 'all') {
        setStateFilter('all');
        if (feed) selectFirstMatch([pickDefaultMatch(feed.matches)].filter(Boolean) as MatchItem[]);
      }
      if (mode === 'official') {
        setStateFilter('official_available');
        selectFirstMatch(officialMatches);
      }
      if (mode === 'watchlist') {
        setStateFilter('watchlist_available');
        selectFirstMatch(watchlistMatches);
      }
      if (mode === 'parlay') {
        setStateFilter('all');
        const firstLegId = feed?.parlays?.[0]?.legs_detail?.[0]?.event_id;
        if (firstLegId) setSelectedId(firstLegId);
      }
    },
    [feed, officialMatches, selectFirstMatch, watchlistMatches],
  );

  return (
    <div className="h-full overflow-y-auto bg-[#11141c] px-5 py-8 text-slate-100 md:px-10">
      <section className="rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_12%_10%,rgba(82,219,169,0.18),transparent_34%),linear-gradient(135deg,#151923_0%,#10131b_56%,#17203d_100%)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.28)] md:p-10">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-4xl">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-4 py-2 text-xs font-black uppercase tracking-[0.24em] text-emerald-200">
              <Trophy className="h-4 w-4" />
              {copy.badge}
            </div>
            <h1 className="text-4xl font-black leading-[0.95] tracking-[-0.05em] text-white md:text-6xl">
              {copy.title}
            </h1>
            <p className="mt-5 max-w-3xl text-lg font-semibold leading-8 text-slate-300">
              {copy.intro}
            </p>
          </div>
          <button
            onClick={loadFeed}
            disabled={isLoading}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-5 py-3 text-sm font-bold text-slate-100 transition hover:bg-white/[0.1] disabled:opacity-60"
          >
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
            {copy.refresh}
          </button>
        </div>

        {feed ? (
        <div className="mt-8 grid gap-4 md:grid-cols-4">
            <StatCard label={copy.totalMatches} value={feed.summary.fixtures} active={summaryMode === 'all'} hint={copy.clickHint} onClick={() => handleSummaryClick('all')} />
            <StatCard label={copy.official} value={feed.summary.matches_with_official} tone="text-emerald-200" active={summaryMode === 'official'} hint={copy.clickHint} onClick={() => handleSummaryClick('official')} />
            <StatCard label={copy.watchlist} value={feed.summary.matches_with_watchlist} tone="text-amber-100" active={summaryMode === 'watchlist'} hint={copy.clickHint} onClick={() => handleSummaryClick('watchlist')} />
            <StatCard label={copy.parlays} value={feed.summary.parlay_candidates} active={summaryMode === 'parlay'} hint={copy.clickHint} onClick={() => handleSummaryClick('parlay')} />
          </div>
        ) : null}

        {feed ? (
          <div className="mt-4 rounded-3xl border border-white/10 bg-black/18 p-4 text-sm font-semibold text-slate-400">
            当前预测只展示未开赛比赛；本次已过滤过期场次 {feed.summary.expired_filtered || 0} 场。
            <span className="ml-3 text-slate-500">
              原始场次 {feed.summary.raw_fixtures ?? feed.summary.fixtures}，当前可预测场次 {feed.summary.current_fixtures ?? feed.summary.fixtures}。
            </span>
          </div>
        ) : null}
      </section>

      {feed ? (
        <SummaryDetailPanel
          copy={copy}
          accuracyLabels={accuracyLabels}
          locale={locale}
          mode={summaryMode}
          officialMatches={officialMatches}
          watchlistMatches={watchlistMatches}
          parlays={feed.parlays}
          onSelectMatch={setSelectedId}
        />
      ) : null}

      {feed && predictionHistory.length ? (
        <section className="mt-6 rounded-[28px] border border-white/10 bg-white/[0.035] p-5">
          <h2 className="text-2xl font-black tracking-[-0.04em] text-white">预测历史记录</h2>
          <p className="mt-2 text-sm font-semibold leading-6 text-slate-500">
            记录每次服务器生成预测后的场次数、过滤数量、高置信和观察候选数量，用于审计每天是否真实更新。
          </p>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {predictionHistory.map((row, index) => (
              <div key={`${row.recorded_at || index}-${row.generated_at || index}`} className="rounded-2xl border border-white/8 bg-black/18 p-4">
                <div className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">
                  {fmtDate(row.recorded_at || row.generated_at, locale)}
                </div>
                <div className="mt-2 text-lg font-black text-white">
                  当前 {row.fixtures_current ?? '-'} / 原始 {row.fixtures_raw ?? '-'}
                </div>
                <div className="mt-2 text-sm font-semibold leading-6 text-slate-400">
                  高置信 {row.official ?? 0} · 观察 {row.watchlist ?? 0} · 组合 {row.parlay_candidates ?? 0} · 过滤 {row.expired_filtered ?? 0}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {error ? (
        <section className="mt-6 rounded-3xl border border-red-400/20 bg-red-500/10 p-5 text-red-100">
          {copy.loadFailed}：{error}
        </section>
      ) : null}

      <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)]">
        <div className="min-w-0 rounded-[28px] border border-white/10 bg-white/[0.035] p-5">
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-2xl font-black tracking-[-0.04em] text-white">{copy.matchList}</h2>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                {copy.generated}：{feed ? fmtDate(feed.generated_at, locale) : '-'}，{copy.version}：{feed?.version || '-'}
              </p>
            </div>
            <div className="grid w-full max-w-full grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_180px]">
              <label className="flex h-11 min-w-0 items-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-3 text-sm text-slate-400">
                <Search className="h-4 w-4" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={copy.searchPlaceholder}
                  className="w-full bg-transparent text-slate-100 outline-none placeholder:text-slate-600"
                />
              </label>
              <select
                value={stateFilter}
                onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}
                className="h-11 w-full rounded-2xl border border-white/10 bg-[#151923] px-3 text-sm font-bold text-slate-200 outline-none"
              >
                <option value="all">{copy.allStatus}</option>
                <option value="official_available">{copy.officialState}</option>
                <option value="watchlist_available">{copy.watchState}</option>
                <option value="no_strong_signal">{copy.noSignalState}</option>
              </select>
            </div>
          </div>

          <div className="mt-5 grid gap-3">
            {filteredMatches.map((match) => {
              const currentState = states[match.prediction_state];
              const rec = match.top_recommendation;
              const isSelected = selectedMatch?.event_id === match.event_id;
              return (
                <button
                  key={match.event_id}
                  onClick={() => setSelectedId(match.event_id)}
                  className={cn(
                    'rounded-3xl border p-4 text-left transition',
                    isSelected
                      ? 'border-emerald-300/45 bg-emerald-300/10 shadow-[0_0_0_1px_rgba(110,231,183,0.12)]'
                      : 'border-white/8 bg-black/15 hover:border-white/16 hover:bg-white/[0.05]',
                  )}
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">
                        {match.competition} · {fmtDate(match.commence_time, locale)}
                      </div>
                      <div className="mt-2 text-xl font-black text-white">
                        {localizedTeamName(match.home_team, locale)} <span className="text-slate-500">vs</span> {localizedTeamName(match.away_team, locale)}
                      </div>
                      <p className="mt-2 text-sm font-semibold text-slate-400">{currentState.detail}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <span className={cn('w-fit rounded-full border px-3 py-1 text-xs font-black', currentState.tone)}>
                        {currentState.label}
                      </span>
                      <span className="rounded-full border border-emerald-300/35 bg-emerald-300/10 px-3 py-1 text-xs font-black text-emerald-100">
                        {copy.viewMatch}
                      </span>
                    </div>
                  </div>
                  {rec ? (
                    <div className="mt-4 grid gap-2 rounded-2xl border border-white/8 bg-black/18 p-3 text-sm font-semibold text-slate-300 md:grid-cols-4">
                      <span className="md:col-span-2">{recommendationTitle(rec, locale)}</span>
                      <span>{accuracyLabels.historicalHitRate} {fmtPct(rec.historical_hit_rate, 1)}</span>
                      <span>{accuracyLabels.accuracyGrade} {rec.accuracy_grade || '-'}</span>
                    </div>
                  ) : null}
                </button>
              );
            })}
            {filteredMatches.length === 0 ? (
              <div className="rounded-3xl border border-white/8 bg-black/15 p-8 text-center text-sm font-bold text-slate-500">
                {copy.noMatches}
              </div>
            ) : null}
          </div>
        </div>

        <aside className="min-w-0 space-y-6">
          <SelectedMatchPanel match={selectedMatch} copy={copy} accuracyLabels={accuracyLabels} locale={locale} />
          <ParlayPanel parlays={relatedParlays} copy={copy} accuracyLabels={accuracyLabels} locale={locale} />
        </aside>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone = 'text-white',
  active,
  hint,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
  active?: boolean;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'min-w-0 rounded-3xl border p-5 text-left transition hover:-translate-y-0.5 hover:border-emerald-300/35 hover:bg-emerald-300/8',
        active ? 'border-emerald-300/45 bg-emerald-300/10' : 'border-white/10 bg-black/18',
      )}
    >
      <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className={cn('mt-3 text-4xl font-black tracking-[-0.05em]', tone)}>{value}</div>
      {hint ? <div className="mt-3 text-xs font-bold text-slate-500">{hint}</div> : null}
    </button>
  );
}

function SummaryDetailPanel({
  copy,
  accuracyLabels,
  locale,
  mode,
  officialMatches,
  watchlistMatches,
  parlays,
  onSelectMatch,
}: {
  copy: ReturnType<typeof copyForLocale>;
  accuracyLabels: ReturnType<typeof footballAccuracyLabels>;
  locale: Locale;
  mode: SummaryMode;
  officialMatches: MatchItem[];
  watchlistMatches: MatchItem[];
  parlays: Parlay[];
  onSelectMatch: (eventId: string) => void;
}) {
  if (mode === 'all') {
    return (
      <section className="mt-6 rounded-[28px] border border-white/10 bg-white/[0.035] p-5">
        <h2 className="text-2xl font-black tracking-[-0.04em] text-white">{copy.summaryAllTitle}</h2>
        <p className="mt-2 text-sm font-semibold leading-6 text-slate-400">{copy.summaryAllBody}</p>
      </section>
    );
  }

  if (mode === 'parlay') {
    return (
      <section className="mt-6 rounded-[28px] border border-emerald-300/20 bg-emerald-300/[0.06] p-5">
        <h2 className="text-2xl font-black tracking-[-0.04em] text-white">
          {copy.summaryParlayTitle} · {parlays.length}
        </h2>
        <p className="mt-2 text-sm font-semibold leading-6 text-slate-400">{copy.summaryParlayBody}</p>
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          {parlays.map((parlay) => (
            <article key={parlay.parlay_id} className="rounded-3xl border border-white/8 bg-black/18 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-lg font-black text-white">
                  {parlay.legs} {copy.legs} · {copy.combinedOdds} {fmtNum(parlay.combo_score, 3)}
                </div>
                <div className="rounded-full border border-white/10 px-3 py-1 text-xs font-black text-slate-300">
                  {parlay.risk_level}
                </div>
              </div>
              <div className="mt-3 grid gap-2">
                {parlay.legs_detail.map((leg, index) => (
                  <div key={`${parlay.parlay_id}-${index}`} className="rounded-2xl bg-white/[0.045] p-3 text-sm font-semibold text-slate-300">
                    <div className="mb-1 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                      {legMetaText(leg, copy, locale)}
                    </div>
                    <div className="font-black text-white">{localizeFootballText(leg.match, locale)}</div>
                  <div className="mt-1 text-slate-400">
                    {copy.market}：{leg.market} · {accuracyLabels.predictedResult}：{localizeFootballText(leg.predicted_result || leg.selection, locale)} · {copy.modelProb}：{fmtPct(leg.model_prob, 1)} · {accuracyLabels.historicalHitRate}：{fmtPct(leg.historical_hit_rate, 1)}
                  </div>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  const matches = mode === 'official' ? officialMatches : watchlistMatches;
  const title = mode === 'official' ? copy.summaryOfficialTitle : copy.summaryWatchTitle;
  const body = mode === 'official' ? copy.summaryOfficialBody : copy.summaryWatchBody;

  return (
    <section className="mt-6 rounded-[28px] border border-emerald-300/20 bg-emerald-300/[0.06] p-5">
      <h2 className="text-2xl font-black tracking-[-0.04em] text-white">
        {title} · {matches.length}
      </h2>
      <p className="mt-2 text-sm font-semibold leading-6 text-slate-400">{body}</p>
      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        {matches.map((match) => {
          const rec = match.top_recommendation || match.recommendations?.[0];
          return (
            <button
              key={match.event_id}
              type="button"
              onClick={() => onSelectMatch(match.event_id)}
              className="rounded-3xl border border-white/8 bg-black/18 p-4 text-left transition hover:border-emerald-300/35 hover:bg-emerald-300/8"
            >
              <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">
                {match.competition} · {fmtDate(match.commence_time, locale)}
              </div>
              <div className="mt-2 text-lg font-black text-white">
                {localizedTeamName(match.home_team, locale)} <span className="text-slate-500">vs</span> {localizedTeamName(match.away_team, locale)}
              </div>
              {rec ? (
                <div className="mt-3 rounded-2xl bg-white/[0.045] p-3 text-sm font-semibold text-slate-300">
                  <div className="mb-1 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    {match.competition} · {copy.kickoff}：{fmtDate(match.commence_time, locale)} · {localizedMatchName(match, locale)}
                  </div>
                  <div className="font-black text-white">{recommendationTitle(rec, locale)}</div>
                  <div className="mt-1 text-slate-400">
                    {accuracyLabels.predictedResult}：{localizeFootballText(rec.predicted_result || rec.selection, locale)} · {copy.modelProb}：{fmtPct(rec.model_prob, 1)} · {accuracyLabels.historicalHitRate}：{fmtPct(rec.historical_hit_rate, 1)} · {accuracyLabels.brier}：{fmtNum(rec.brier_score, 3)} · {accuracyLabels.calibrationError}：{fmtPct(rec.calibration_error, 1)}
                  </div>
                  {rec.odds_source_warning ? (
                    <div className="mt-2 text-xs font-bold text-amber-200">{rec.odds_source_warning}</div>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-3 text-xs font-black uppercase tracking-[0.14em] text-emerald-200">{copy.viewMatch}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SelectedMatchPanel({
  match,
  copy,
  accuracyLabels,
  locale,
}: {
  match: MatchItem | null;
  copy: ReturnType<typeof copyForLocale>;
  accuracyLabels: ReturnType<typeof footballAccuracyLabels>;
  locale: Locale;
}) {
  if (!match) {
    return (
      <section className="rounded-[28px] border border-white/10 bg-white/[0.035] p-6 text-slate-400">
        {copy.selectMatch}
      </section>
    );
  }

  const recommendations = match.recommendations?.length ? match.recommendations : match.top_recommendation ? [match.top_recommendation] : [];

  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.035] p-6">
      <div className="text-xs font-black uppercase tracking-[0.2em] text-emerald-300">{copy.matchSignal}</div>
      <h2 className="mt-3 text-3xl font-black tracking-[-0.04em] text-white">
        {localizedMatchName(match, locale)}
      </h2>
      <p className="mt-2 text-sm font-semibold text-slate-500">
        {match.competition} · {copy.kickoff} {fmtDate(match.commence_time, locale)} · {copy.candidates} {match.all_candidate_count}
      </p>

      <div className="mt-5 grid gap-3">
        {recommendations.slice(0, 5).map((rec, index) => (
          <div key={`${rec.market}-${rec.selection}-${index}`} className="rounded-3xl border border-white/8 bg-black/18 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="mb-1 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                  {match.competition} · {copy.kickoff}：{fmtDate(match.commence_time, locale)} · {localizedMatchName(match, locale)}
                </div>
                <div className="text-lg font-black text-white">{recommendationTitle(rec, locale)}</div>
                <div className="mt-1 text-sm font-semibold text-slate-500">
                  {accuracyLabels.predictedResult}：{localizeFootballText(rec.predicted_result || rec.selection, locale)} · {copy.state}：{rec.accuracy_grade || rec.status || '-'}
                </div>
              </div>
              <span className="w-fit rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1 text-xs font-black text-emerald-200">
                {rec.confidence_level || rec.confidence || 'model-signal'}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-5">
              <MiniMetric label={copy.modelProb} value={fmtPct(rec.model_prob, 1)} />
              <MiniMetric label={accuracyLabels.historicalHitRate} value={fmtPct(rec.historical_hit_rate, 1)} />
              <MiniMetric label={accuracyLabels.hitRateLift} value={fmtPct(rec.hit_rate_lift, 1)} />
              <MiniMetric label={accuracyLabels.brier} value={fmtNum(rec.brier_score, 3)} />
              <MiniMetric label={accuracyLabels.calibrationError} value={fmtPct(rec.calibration_error, 1)} />
              <MiniMetric label={accuracyLabels.modelAgreement} value={fmtPct(rec.model_agreement, 1)} />
              <MiniMetric label={accuracyLabels.predictionConfidence} value={fmtPct(rec.prediction_confidence, 1)} />
              <MiniMetric label={copy.odds} value={fmtNum(rec.odds, 2)} />
            </div>
            <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.035] p-3 text-xs font-bold text-slate-500">
              {accuracyLabels.oddsReference}：{copy.marketProb} {fmtPct(rec.market_prob, 1)} · Edge {fmtPct(rec.edge, 1)} · {oddsSourceNode(rec, copy)}
            </div>
            {rec.odds_source_warning ? (
              <div className="mt-4 rounded-2xl border border-amber-300/15 bg-amber-300/8 p-3 text-sm font-semibold text-amber-100">
                {rec.odds_source_warning}
              </div>
            ) : null}
            {rec.risk_notes?.length ? (
              <div className="mt-4 rounded-2xl border border-amber-300/15 bg-amber-300/8 p-3 text-sm font-semibold text-amber-100">
                {rec.risk_notes.join('；')}
              </div>
            ) : null}
            {rec.reject_reason ? (
              <div className="mt-4 rounded-2xl border border-slate-500/15 bg-slate-500/8 p-3 text-sm font-semibold text-slate-400">
                {copy.rejectReason}：{rec.reject_reason}
              </div>
            ) : null}
            {rec.failure_risk ? (
              <div className="mt-4 rounded-2xl border border-slate-500/15 bg-slate-500/8 p-3 text-sm font-semibold text-slate-400">
                {accuracyLabels.failureRisk}：{rec.failure_risk}
              </div>
            ) : null}
          </div>
        ))}
        {recommendations.length === 0 ? (
          <div className="rounded-3xl border border-white/8 bg-black/18 p-5 text-sm font-bold text-slate-500">
            {copy.noStrongRec}
          </div>
        ) : null}
      </div>

      {match.refresh_context ? (
        <div className="mt-5 rounded-3xl border border-white/8 bg-black/18 p-4">
          <div className="flex items-center gap-2 text-sm font-black text-slate-200">
            <ShieldAlert className="h-4 w-4 text-amber-200" />
            {copy.refreshAdvice}
          </div>
          <p className="mt-2 text-sm font-semibold leading-6 text-slate-400">
            {match.refresh_context.tracking_note || copy.defaultTrackingNote}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function ParlayPanel({
  parlays,
  copy,
  accuracyLabels,
  locale,
}: {
  parlays: Parlay[];
  copy: ReturnType<typeof copyForLocale>;
  accuracyLabels: ReturnType<typeof footballAccuracyLabels>;
  locale: Locale;
}) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.035] p-6">
      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.2em] text-emerald-300">
        <TrendingUp className="h-4 w-4" />
        {copy.parlayCandidates}
      </div>
      <h2 className="mt-3 text-2xl font-black tracking-[-0.04em] text-white">{copy.parlayCandidates}</h2>
      <div className="mt-5 grid gap-3">
        {parlays.map((parlay) => (
          <div key={parlay.parlay_id} className="rounded-3xl border border-white/8 bg-black/18 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="font-black text-white">{parlay.legs} {copy.legs} · {copy.combinedOdds} {fmtNum(parlay.combo_score, 3)}</div>
              <span className="rounded-full border border-white/10 px-3 py-1 text-xs font-black text-slate-300">
                {parlay.risk_level}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <MiniMetric label={copy.hitProb} value={fmtPct(parlay.average_model_prob ?? parlay.model_hit_prob, 1)} />
              <MiniMetric label={accuracyLabels.historicalHitRate} value={fmtPct(parlay.average_historical_hit_rate, 1)} />
              <MiniMetric label={copy.minStability} value={fmtPct(parlay.average_calibration_error === null || parlay.average_calibration_error === undefined ? null : 1 - parlay.average_calibration_error, 1)} />
            </div>
            <div className="mt-3 grid gap-2">
              {parlay.legs_detail.map((leg, index) => (
                <div key={`${parlay.parlay_id}-panel-${index}`} className="rounded-2xl bg-white/[0.045] p-3 text-xs font-semibold text-slate-400">
                  <div className="mb-1 font-black uppercase tracking-[0.14em] text-slate-500">{legMetaText(leg, copy, locale)}</div>
                  <span className="font-black text-slate-200">{localizeFootballText(leg.match, locale)}</span> · {copy.market}：{leg.market} · {accuracyLabels.predictedResult}：{localizeFootballText(leg.predicted_result || leg.selection, locale)} · {copy.modelProb}：{fmtPct(leg.model_prob, 1)} · {accuracyLabels.historicalHitRate}：{fmtPct(leg.historical_hit_rate, 1)} · {accuracyLabels.accuracyGrade}：{leg.accuracy_grade || '-'}
                </div>
              ))}
            </div>
            <p className="mt-3 text-sm font-semibold leading-6 text-slate-500">{parlay.note}</p>
          </div>
        ))}
        {parlays.length === 0 ? (
          <div className="rounded-3xl border border-white/8 bg-black/18 p-5 text-sm font-bold text-slate-500">
            {copy.noParlays}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MiniMetric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white/[0.045] p-3">
      <div className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="mt-1 text-base font-black text-white">{value}</div>
    </div>
  );
}
