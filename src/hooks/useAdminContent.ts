import { useEffect, useMemo, useRef, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../lib/AuthContext';
import { officialSiteContent, OfficialSiteContent } from '../content/officialSiteContent';
import { hfcdWorkbenchDefaultCopy, HFCDWorkbenchCopy } from '../content/hfcdWorkbenchContent';

const ADMIN_CONTENT_VERSION = 'official-site-homepage-2026-05-01-v3';
const STORAGE_KEY = `adminOfficialSiteDraft:${ADMIN_CONTENT_VERSION}`;
const ADMIN_CONTENT_DOC_ID = 'official-site';

type IndustryDraft = {
  oneLiner: string;
  problem: string;
  shortValue: string;
  longValue: string;
};

type EvidenceHighlightDraft = {
  title: string;
  detail: string;
};

type EvidenceMetricDraft = {
  label: string;
  value: string;
  note: string;
};

type FaqDraft = {
  q: string;
  a: string;
};

export type AdminContentDraft = {
  contentVersion: string;
  seoTitle: string;
  seoDescription: string;
  seoImage: string;
  heroBadge: string;
  heroTitle: string;
  heroSubtitle: string;
  heroPrimaryCtaLabel: string;
  heroPrimaryCtaHref: string;
  heroSecondaryCtaLabel: string;
  heroSecondaryCtaHref: string;
  definitionTitle: string;
  definitionParagraphs: string[];
  whyNowTitle: string;
  whyNowBullets: string[];
  evidenceTitle: string;
  evidenceIntro: string;
  evidenceHighlights: EvidenceHighlightDraft[];
  evidenceMetrics: EvidenceMetricDraft[];
  industryMacroThesis: string;
  experimentTitle: string;
  experimentIntro: string;
  experimentName: string;
  experimentStatus: string;
  experimentSummary: string;
  experimentNext: string;
  bookTitle: string;
  bookBody: string;
  bookHref: string;
  faq: FaqDraft[];
  industries: Record<string, IndustryDraft>;
  hfcdWorkbench: HFCDWorkbenchCopy;
};

type AdminContentSyncState = 'idle' | 'loading' | 'synced' | 'saving' | 'fallback-local' | 'error';

function buildInitialDraft(): AdminContentDraft {
  return {
    contentVersion: ADMIN_CONTENT_VERSION,
    seoTitle: officialSiteContent.seo.title,
    seoDescription: officialSiteContent.seo.description,
    seoImage: officialSiteContent.seo.image,
    heroBadge: officialSiteContent.hero.badge,
    heroTitle: officialSiteContent.hero.title,
    heroSubtitle: officialSiteContent.hero.subtitle,
    heroPrimaryCtaLabel: officialSiteContent.hero.primaryCta.label,
    heroPrimaryCtaHref: officialSiteContent.hero.primaryCta.href,
    heroSecondaryCtaLabel: officialSiteContent.hero.secondaryCta.label,
    heroSecondaryCtaHref: officialSiteContent.hero.secondaryCta.href,
    definitionTitle: officialSiteContent.definition.title,
    definitionParagraphs: [...officialSiteContent.definition.paragraphs],
    whyNowTitle: officialSiteContent.whyNow.title,
    whyNowBullets: [...officialSiteContent.whyNow.bullets],
    evidenceTitle: officialSiteContent.evidence.title,
    evidenceIntro: officialSiteContent.evidence.intro,
    evidenceHighlights: officialSiteContent.evidence.highlights.map((item) => ({ ...item })),
    evidenceMetrics: officialSiteContent.evidence.metrics.map((item) => ({ ...item })),
    industryMacroThesis: officialSiteContent.industries.find((item) => item.id === 'overview')?.longValue || '',
    experimentTitle: officialSiteContent.experiment.title,
    experimentIntro: officialSiteContent.experiment.intro,
    experimentName: officialSiteContent.experiment.featured.name,
    experimentStatus: officialSiteContent.experiment.featured.status,
    experimentSummary: officialSiteContent.experiment.featured.summary,
    experimentNext: officialSiteContent.experiment.featured.next,
    bookTitle: officialSiteContent.book.title,
    bookBody: officialSiteContent.book.body,
    bookHref: officialSiteContent.book.href,
    faq: officialSiteContent.faq.map((item) => ({ ...item })),
    industries: Object.fromEntries(
      officialSiteContent.industries
        .filter((item) => item.id !== 'overview')
        .map((item) => [
          item.id,
          {
            oneLiner: item.oneLiner,
            problem: item.problem,
            shortValue: item.shortValue,
            longValue: item.longValue,
          },
        ])
    ),
    hfcdWorkbench: { ...hfcdWorkbenchDefaultCopy },
  };
}

function isCurrentDraft(draft: Partial<AdminContentDraft> | undefined): draft is Partial<AdminContentDraft> {
  return draft?.contentVersion === ADMIN_CONTENT_VERSION;
}

function mergeDraftIntoContent(draft: AdminContentDraft): OfficialSiteContent {
  const next = JSON.parse(JSON.stringify(officialSiteContent)) as OfficialSiteContent;
  next.seo.title = draft.seoTitle;
  next.seo.description = draft.seoDescription;
  next.seo.image = draft.seoImage;
  next.hero.badge = draft.heroBadge;
  next.hero.title = draft.heroTitle;
  next.hero.subtitle = draft.heroSubtitle;
  next.hero.primaryCta.label = draft.heroPrimaryCtaLabel;
  next.hero.primaryCta.href = draft.heroPrimaryCtaHref;
  next.hero.secondaryCta.label = draft.heroSecondaryCtaLabel;
  next.hero.secondaryCta.href = draft.heroSecondaryCtaHref;
  next.definition.title = draft.definitionTitle;
  next.definition.paragraphs = draft.definitionParagraphs.filter((item) => item.trim().length > 0);
  next.whyNow.title = draft.whyNowTitle;
  next.whyNow.bullets = draft.whyNowBullets.filter((item) => item.trim().length > 0);
  next.evidence.title = draft.evidenceTitle;
  next.evidence.intro = draft.evidenceIntro;
  next.evidence.highlights = draft.evidenceHighlights
    .filter((item) => item.title.trim().length > 0 || item.detail.trim().length > 0)
    .map((item) => ({ ...item }));
  next.evidence.metrics = draft.evidenceMetrics
    .filter((item) => item.label.trim().length > 0 || item.value.trim().length > 0 || item.note.trim().length > 0)
    .map((item) => ({ ...item }));
  next.experiment.title = draft.experimentTitle;
  next.experiment.intro = draft.experimentIntro;
  next.experiment.featured.name = draft.experimentName;
  next.experiment.featured.status = draft.experimentStatus;
  next.experiment.featured.summary = draft.experimentSummary;
  next.experiment.featured.next = draft.experimentNext;
  next.book.title = draft.bookTitle;
  next.book.body = draft.bookBody;
  next.book.href = draft.bookHref;
  next.faq = draft.faq.filter((item) => item.q.trim().length > 0 || item.a.trim().length > 0).map((item) => ({ ...item }));

  next.industries = next.industries.map((item) => {
    if (item.id === 'overview') {
      return { ...item, longValue: draft.industryMacroThesis };
    }

    const industryDraft = draft.industries[item.id];
    if (!industryDraft) return item;

    return {
      ...item,
      oneLiner: industryDraft.oneLiner,
      problem: industryDraft.problem,
      shortValue: industryDraft.shortValue,
      longValue: industryDraft.longValue,
    };
  });

  return next;
}

export function useAdminContent() {
  const { workspaceId, isAdmin } = useAuth();
  const [draft, setDraft] = useState<AdminContentDraft>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return buildInitialDraft();

    try {
      const parsed = JSON.parse(saved) as Partial<AdminContentDraft>;
      if (!isCurrentDraft(parsed)) return buildInitialDraft();
      const initial = buildInitialDraft();
      return {
        ...initial,
        ...parsed,
        definitionParagraphs: Array.isArray(parsed.definitionParagraphs) ? parsed.definitionParagraphs : initial.definitionParagraphs,
        whyNowBullets: Array.isArray(parsed.whyNowBullets) ? parsed.whyNowBullets : initial.whyNowBullets,
        evidenceHighlights: Array.isArray(parsed.evidenceHighlights)
          ? parsed.evidenceHighlights.map((item, index) => ({
              ...initial.evidenceHighlights[index],
              ...item,
            }))
          : initial.evidenceHighlights,
        evidenceMetrics: Array.isArray(parsed.evidenceMetrics)
          ? parsed.evidenceMetrics.map((item, index) => ({
              ...initial.evidenceMetrics[index],
              ...item,
            }))
          : initial.evidenceMetrics,
        faq: Array.isArray(parsed.faq)
          ? parsed.faq.map((item, index) => ({
              ...(initial.faq[index] || { q: '', a: '' }),
              ...item,
            }))
          : initial.faq,
        industries: {
          ...initial.industries,
          ...(parsed.industries || {}),
        },
        hfcdWorkbench: {
          ...initial.hfcdWorkbench,
          ...(parsed.hfcdWorkbench || {}),
        },
      };
    } catch {
      return buildInitialDraft();
    }
  });
  const [syncState, setSyncState] = useState<AdminContentSyncState>('idle');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [hasLoadedRemote, setHasLoadedRemote] = useState(false);
  const lastSyncedJsonRef = useRef<string | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  }, [draft]);

  useEffect(() => {
    if (!workspaceId || !isAdmin) {
      setSyncState('fallback-local');
      setHasLoadedRemote(false);
      return;
    }

    setSyncState('loading');
    setSyncError(null);
    const contentRef = doc(db, 'workspaces', workspaceId, 'admin_content', ADMIN_CONTENT_DOC_ID);

    const unsubscribe = onSnapshot(
      contentRef,
      (snapshot) => {
        if (snapshot.exists()) {
          const parsed = snapshot.data()?.draft as Partial<AdminContentDraft> | undefined;
          const initial = buildInitialDraft();
          if (!isCurrentDraft(parsed)) {
            const nextJson = JSON.stringify(initial);
            lastSyncedJsonRef.current = nextJson;
            setDraft((prev) => {
              const prevJson = JSON.stringify(prev);
              return prevJson === nextJson ? prev : initial;
            });
            void setDoc(
              contentRef,
              {
                draft: initial,
                updatedAt: Date.now(),
                migrationReason: 'reset-outdated-official-site-content',
              },
              { merge: true }
            ).catch((error) => {
              console.error('Failed to migrate outdated admin content:', error);
            });
            setHasLoadedRemote(true);
            setSyncState('synced');
            setSyncError(null);
            return;
          }
          const merged: AdminContentDraft = {
            ...initial,
            ...(parsed || {}),
            definitionParagraphs: Array.isArray(parsed?.definitionParagraphs) ? parsed.definitionParagraphs : initial.definitionParagraphs,
            whyNowBullets: Array.isArray(parsed?.whyNowBullets) ? parsed.whyNowBullets : initial.whyNowBullets,
            evidenceHighlights: Array.isArray(parsed?.evidenceHighlights)
              ? parsed.evidenceHighlights.map((item, index) => ({
                  ...initial.evidenceHighlights[index],
                  ...item,
                }))
              : initial.evidenceHighlights,
            evidenceMetrics: Array.isArray(parsed?.evidenceMetrics)
              ? parsed.evidenceMetrics.map((item, index) => ({
                  ...initial.evidenceMetrics[index],
                  ...item,
                }))
              : initial.evidenceMetrics,
            faq: Array.isArray(parsed?.faq)
              ? parsed.faq.map((item, index) => ({
                  ...(initial.faq[index] || { q: '', a: '' }),
                  ...item,
                }))
              : initial.faq,
            industries: {
              ...initial.industries,
              ...((parsed?.industries as Partial<Record<string, IndustryDraft>>) || {}),
            },
            hfcdWorkbench: {
              ...initial.hfcdWorkbench,
              ...(parsed?.hfcdWorkbench || {}),
            },
          };
          const nextJson = JSON.stringify(merged);
          lastSyncedJsonRef.current = nextJson;
          setDraft((prev) => {
            const prevJson = JSON.stringify(prev);
            return prevJson === nextJson ? prev : merged;
          });
        }

        setHasLoadedRemote(true);
        setSyncState('synced');
        setSyncError(null);
      },
      (error) => {
        console.error('Failed to load admin content from Firestore:', error);
        setHasLoadedRemote(true);
        setSyncState('fallback-local');
        setSyncError('云端内容读取失败，当前退回本地草稿。');
      }
    );

    return () => unsubscribe();
  }, [workspaceId, isAdmin]);

  useEffect(() => {
    if (!workspaceId || !isAdmin || !hasLoadedRemote) return;

    const draftJson = JSON.stringify(draft);
    if (draftJson === lastSyncedJsonRef.current) return;

    setSyncState('saving');
    setSyncError(null);

    const timeoutId = window.setTimeout(async () => {
      try {
        const contentRef = doc(db, 'workspaces', workspaceId, 'admin_content', ADMIN_CONTENT_DOC_ID);
        await setDoc(
          contentRef,
          {
            draft,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
        lastSyncedJsonRef.current = draftJson;
        setSyncState('synced');
      } catch (error) {
        console.error('Failed to save admin content to Firestore:', error);
        setSyncState('fallback-local');
        setSyncError('云端保存失败，当前仅保存在本地浏览器。');
      }
    }, 500);

    return () => window.clearTimeout(timeoutId);
  }, [draft, hasLoadedRemote, isAdmin, workspaceId]);

  const content = useMemo(() => mergeDraftIntoContent(draft), [draft]);

  const updateField = (
    field: keyof Omit<AdminContentDraft, 'contentVersion' | 'industries' | 'hfcdWorkbench'>,
    value: string
  ) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const updateHfcdWorkbenchField = <K extends keyof HFCDWorkbenchCopy>(field: K, value: HFCDWorkbenchCopy[K]) => {
    setDraft((prev) => ({
      ...prev,
      hfcdWorkbench: {
        ...prev.hfcdWorkbench,
        [field]: value,
      },
    }));
  };

  const updateListField = (field: 'definitionParagraphs' | 'whyNowBullets', index: number, value: string) => {
    setDraft((prev) => ({
      ...prev,
      [field]: prev[field].map((item, itemIndex) => (itemIndex === index ? value : item)),
    }));
  };

  const addListFieldItem = (field: 'definitionParagraphs' | 'whyNowBullets') => {
    setDraft((prev) => ({
      ...prev,
      [field]: [...prev[field], ''],
    }));
  };

  const removeListFieldItem = (field: 'definitionParagraphs' | 'whyNowBullets', index: number) => {
    setDraft((prev) => ({
      ...prev,
      [field]: prev[field].filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const updateEvidenceHighlight = (index: number, field: keyof EvidenceHighlightDraft, value: string) => {
    setDraft((prev) => ({
      ...prev,
      evidenceHighlights: prev.evidenceHighlights.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item
      ),
    }));
  };

  const addEvidenceHighlight = () => {
    setDraft((prev) => ({
      ...prev,
      evidenceHighlights: [...prev.evidenceHighlights, { title: '', detail: '' }],
    }));
  };

  const removeEvidenceHighlight = (index: number) => {
    setDraft((prev) => ({
      ...prev,
      evidenceHighlights: prev.evidenceHighlights.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const updateEvidenceMetric = (index: number, field: keyof EvidenceMetricDraft, value: string) => {
    setDraft((prev) => ({
      ...prev,
      evidenceMetrics: prev.evidenceMetrics.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item
      ),
    }));
  };

  const addEvidenceMetric = () => {
    setDraft((prev) => ({
      ...prev,
      evidenceMetrics: [...prev.evidenceMetrics, { label: '', value: '', note: '' }],
    }));
  };

  const removeEvidenceMetric = (index: number) => {
    setDraft((prev) => ({
      ...prev,
      evidenceMetrics: prev.evidenceMetrics.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const updateFaq = (index: number, field: keyof FaqDraft, value: string) => {
    setDraft((prev) => ({
      ...prev,
      faq: prev.faq.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)),
    }));
  };

  const addFaq = () => {
    setDraft((prev) => ({
      ...prev,
      faq: [...prev.faq, { q: '', a: '' }],
    }));
  };

  const removeFaq = (index: number) => {
    setDraft((prev) => ({
      ...prev,
      faq: prev.faq.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const updateIndustry = (industryId: string, field: keyof IndustryDraft, value: string) => {
    setDraft((prev) => ({
      ...prev,
      industries: {
        ...prev.industries,
        [industryId]: {
          ...prev.industries[industryId],
          [field]: value,
        },
      },
    }));
  };

  const resetDraft = () => {
    const initial = buildInitialDraft();
    setDraft(initial);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
  };

  return {
    draft,
    content,
    updateField,
    updateListField,
    addListFieldItem,
    removeListFieldItem,
    updateEvidenceHighlight,
    addEvidenceHighlight,
    removeEvidenceHighlight,
    updateEvidenceMetric,
    addEvidenceMetric,
    removeEvidenceMetric,
    updateFaq,
    addFaq,
    removeFaq,
    updateIndustry,
    updateHfcdWorkbenchField,
    resetDraft,
    syncState,
    syncError,
  };
}
