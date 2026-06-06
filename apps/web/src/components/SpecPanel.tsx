// API reference view: embeds the runtime's Swagger UI and links out to the raw
// OpenAPI document. Kept from the original app, restyled to Paste.
import { Icon } from "../ui/icons";

interface Props {
  baseUrl: string;
}

export function SpecPanel({ baseUrl }: Props) {
  return (
    <div className="spec-view">
      <div className="spec-links">
        <span>Reference for the runtime's HTTP API.</span>
        <a href={`${baseUrl}/docs`} target="_blank" rel="noreferrer">
          <Icon name="link-external" style={{ width: 13, height: 13, display: "inline-flex" }} />
          Swagger UI
        </a>
        <a className="mono" href={`${baseUrl}/openapi.json`} target="_blank" rel="noreferrer">
          openapi.json
        </a>
      </div>
      <iframe className="spec-frame" title="OpenAPI docs" src={`${baseUrl}/docs`} />
    </div>
  );
}
