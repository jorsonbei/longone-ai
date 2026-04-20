import { useState, useEffect } from 'react';

const DEFAULT_PERSONA = `作为用户，你可以在这里添加自定义扩展指令。
请注意：物性论OS 的核心《物性论》绝对世界观及参数表 (如 Σ⁺, η, φ, Π, Bσ, Ω 等) 已经是系统的底层内核，会在每次对话中被自动注入到 AI，你无需在此重复定义。

你可以在这里补充个性化要求：
- 比如：“回复时尽量使用金字塔原理，第一句先说结论。”
- 比如：“不要输出过长的代码，尽量只说伪代码结构。”`;

export function useSettings() {
  const [systemInstruction, setSystemInstruction] = useState<string>(() => {
    return localStorage.getItem('systemInstruction') || DEFAULT_PERSONA;
  });

  useEffect(() => {
    localStorage.setItem('systemInstruction', systemInstruction);
  }, [systemInstruction]);

  return { systemInstruction, setSystemInstruction };
}
