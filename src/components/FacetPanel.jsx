const FACETS = [
  { key: "mayor", label: "Mayor" },
  { key: "text_quality", label: "Text quality" },
  { key: "source", label: "Source" },
];

export default function FacetPanel({ state, counts, onChange, onClear }) {
  const toggle = (key, value) => {
    const current = state[key] ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ [key]: next });
  };

  const active =
    FACETS.some((f) => (state[f.key] ?? []).length > 0) ||
    state.yearMin !== null ||
    state.yearMax !== null ||
    state.isEmergency !== null;

  return (
    <div className="panel">
      <h2>Filters</h2>

      <div className="facet">
        <h3>Years</h3>
        <div className="years">
          <input
            type="number"
            placeholder="from"
            value={state.yearMin ?? ""}
            onChange={(e) =>
              onChange({ yearMin: e.target.value ? Number(e.target.value) : null })
            }
          />
          <span>–</span>
          <input
            type="number"
            placeholder="to"
            value={state.yearMax ?? ""}
            onChange={(e) =>
              onChange({ yearMax: e.target.value ? Number(e.target.value) : null })
            }
          />
        </div>
      </div>

      <div className="facet">
        <h3>Kind</h3>
        {[
          { v: null, l: "All orders" },
          { v: false, l: "Regular only" },
          { v: true, l: "Emergency only" },
        ].map(({ v, l }) => (
          <label key={String(v)}>
            <input
              type="radio"
              name="isEmergency"
              checked={state.isEmergency === v}
              onChange={() => onChange({ isEmergency: v })}
            />
            {l}
          </label>
        ))}
      </div>

      {FACETS.map(({ key, label }) => (
        <div className="facet" key={key}>
          <h3>{label}</h3>
          {(counts[key] ?? []).map(({ value, n }) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={(state[key] ?? []).includes(value)}
                onChange={() => toggle(key, value)}
              />
              {value}
              <span className="n">{n.toLocaleString()}</span>
            </label>
          ))}
        </div>
      ))}

      {active ? (
        <button className="clear" onClick={onClear}>
          Clear all filters
        </button>
      ) : null}
    </div>
  );
}
