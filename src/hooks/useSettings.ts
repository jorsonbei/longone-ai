import { useState, useEffect } from 'react';

const DEFAULT_PERSONA = `默认偏好：
- 简单问候、测试消息或确认句先自然短答，不要过度解读。
- 真正进入分析时，先给结论，再展开结构。
- 除非我明确要求，否则避免过长、过重的理论铺垫。

你也可以在这里补充自己的表达偏好。`;

export function useSettings() {
  const [systemInstruction, setSystemInstruction] = useState<string>(() => {
    return localStorage.getItem('systemInstruction') || DEFAULT_PERSONA;
  });

  useEffect(() => {
    localStorage.setItem('systemInstruction', systemInstruction);
  }, [systemInstruction]);

  return { systemInstruction, setSystemInstruction };
}
