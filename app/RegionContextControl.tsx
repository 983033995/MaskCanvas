import type { Region, RegionContext } from '../packages/shared/types';

interface Props {
  region: Region;
  width: number;
  height: number;
  disabled?: boolean;
  onChange: (context: RegionContext | undefined) => void;
}

function defaultContext(region: Region, width: number, height: number): RegionContext {
  let left = width, top = height, right = 0, bottom = 0;
  for (const shape of region.shapes.filter(item => !item.subtract)) {
    if (shape.type === 'rect') {
      left = Math.min(left, shape.x); top = Math.min(top, shape.y);
      right = Math.max(right, shape.x + shape.width); bottom = Math.max(bottom, shape.y + shape.height);
    } else for (const point of shape.points) {
      const radius = shape.type === 'brush' ? shape.radius : 0;
      left = Math.min(left, point.x - radius); top = Math.min(top, point.y - radius);
      right = Math.max(right, point.x + radius); bottom = Math.max(bottom, point.y + radius);
    }
  }
  if (right <= left || bottom <= top) return { x: 0, y: 0, width, height };
  left = Math.max(0, Math.floor(left - 128)); top = Math.max(0, Math.floor(top - 128));
  right = Math.min(width, Math.ceil(right + 128)); bottom = Math.min(height, Math.ceil(bottom + 128));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function RegionContextControl({ region, width, height, onChange, disabled = false }: Props) {
  if (region.kind !== 'edit') return null;
  const context = region.context;
  return <details className="slider-field">
    <summary>模型观察范围</summary>
    <p className="helper-text">观察范围帮助模型理解周围内容；只有编辑选区允许改变，保护区仍保持不变。</p>
    <label className="permission-consent"><input type="checkbox" checked={Boolean(context)} disabled={disabled} onChange={event => onChange(event.target.checked ? defaultContext(region, width, height) : undefined)} /><span>自定义上下文</span></label>
    {context ? <>
      {(['x', 'y', 'width', 'height'] as const).map(key => <label className="field-label" key={key}>
        {{ x: '左侧原图坐标', y: '上方原图坐标', width: '观察宽度', height: '观察高度' }[key]}
        <input type="number" aria-label={`上下文${key}`} value={context[key]} min={key === 'width' || key === 'height' ? 1 : 0} max={key === 'x' || key === 'width' ? width : height} step={1} disabled={disabled} onWheel={event => event.currentTarget.blur()} onChange={event => onChange({ ...context, [key]: Number(event.target.value) })} />
      </label>)}
      <p className="helper-text">以原图像素保存。范围须包含整个编辑选区；扩大后仍需满足后端处理尺寸限制。</p>
    </> : <p className="helper-text">自动使用选区附近的原图上下文，不缩放整张照片。</p>}
  </details>;
}
