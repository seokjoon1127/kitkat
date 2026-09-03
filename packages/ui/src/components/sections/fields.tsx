// 인스펙터 공용 입력 컨트롤 — 슬라이더/컬러는 200ms 디바운스, 숫자/텍스트는 blur·Enter 확정
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Option } from './inspector-utils.js';
import { KeyframeDot } from './keyframe-dot.js';

/** 로컬 값은 즉시 반영하고, 커밋은 200ms 디바운스한다. 외부 값 변경(undo 등)은 대기 중이 아닐 때 동기화. */
export function useDebouncedCommit<T>(
  value: T,
  commit: (v: T) => void,
  delayMs = 200,
): [T, (v: T) => void] {
  const [local, setLocal] = useState(value);
  const timer = useRef<number | null>(null);
  const pending = useRef(false);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (!pending.current) setLocal(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const set = (v: T) => {
    setLocal(v);
    pending.current = true;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      pending.current = false;
      timer.current = null;
      commitRef.current(v);
    }, delayMs);
  };
  return [local, set];
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="insp-section">
      <h3 className="insp-section-title">{title}</h3>
      <div className="insp-section-body">{children}</div>
    </section>
  );
}

/**
 * kfPath 가 있으면 값 오른쪽에 키프레임 버튼(◆)이 붙는다.
 * 그때는 <label> 대신 <div> 로 그린다 — 라벨을 누르면 «첫 번째 컨트롤»로 클릭이 전달되는데,
 * 버튼이 들어가면 그 규칙이 헷갈리게 동작한다(CommonSection 의 FreezeRow 와 같은 이유).
 */
export function Row({
  label,
  kfPath,
  kfValue,
  children,
}: {
  label: string;
  kfPath?: string;
  /** 화면에 보이는 현재 값 — 문서에 아직 없는 값을 키프레임 걸 때 이 값으로 적는다 */
  kfValue?: number;
  children: ReactNode;
}) {
  const inner = (
    <>
      <span className="insp-label">{label}</span>
      <span className="insp-control">
        {children}
        {kfPath ? <KeyframeDot path={kfPath} value={kfValue} /> : null}
      </span>
    </>
  );
  return kfPath ? (
    <div className="insp-row">{inner}</div>
  ) : (
    <label className="insp-row">{inner}</label>
  );
}

export function SliderField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  digits?: number;
  /** 키프레임 경로 — 주면 오른쪽에 ◆ 버튼이 붙는다 (W8 F13) */
  kfPath?: string;
  onCommit: (v: number) => void;
}) {
  const { label, value, min, max, step = 0.01, digits = 2, kfPath, onCommit } = props;
  const [local, setLocal] = useDebouncedCommit(value, onCommit);
  return (
    <Row label={label} kfPath={kfPath} kfValue={local}>
      <input
        className="insp-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={(e) => setLocal(Number(e.target.value))}
      />
      <span className="insp-value">{local.toFixed(digits)}</span>
    </Row>
  );
}

/** 라벨 없는 숫자 입력(blur·Enter 확정) — 표(키프레임 등)에서 사용 */
export function BareNumber(props: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  title?: string;
  className?: string;
}) {
  const { value, onCommit, min, max, step = 1, title, className } = props;
  const [text, setText] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    let v = n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    setText(String(v));
    if (v !== value) onCommit(v);
  };

  return (
    <input
      className={className ?? 'insp-number'}
      type="number"
      step={step}
      title={title}
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function NumberField(props: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  /** 키프레임 경로 — 주면 오른쪽에 ◆ 버튼이 붙는다 (W8 F13) */
  kfPath?: string;
}) {
  const { label, suffix, kfPath, ...rest } = props;
  return (
    <Row label={label} kfPath={kfPath} kfValue={rest.value}>
      <BareNumber {...rest} />
      {suffix ? <span className="insp-suffix">{suffix}</span> : null}
    </Row>
  );
}

export function ColorField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [local, setLocal] = useDebouncedCommit(value, onCommit);
  return (
    <Row label={label}>
      <input
        className="insp-color"
        type="color"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
      />
      <span className="insp-value">{local}</span>
    </Row>
  );
}

export function CheckField({
  label,
  checked,
  onCommit,
}: {
  label: string;
  checked: boolean;
  onCommit: (v: boolean) => void;
}) {
  return (
    <Row label={label}>
      <input
        className="insp-check"
        type="checkbox"
        checked={checked}
        onChange={(e) => onCommit(e.target.checked)}
      />
    </Row>
  );
}

export function SelectField({
  label,
  value,
  options,
  onCommit,
}: {
  label: string;
  value: string;
  options: Option[];
  onCommit: (v: string) => void;
}) {
  return (
    <Row label={label}>
      <select className="insp-select" value={value} onChange={(e) => onCommit(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function TextField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <Row label={label}>
      <input
        className="insp-text"
        type="text"
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </Row>
  );
}

export function TextAreaField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return (
    <div className="insp-col">
      <span className="insp-label">{label}</span>
      <textarea
        className="insp-textarea"
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          if (text !== value) onCommit(text);
        }}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}
