interface Props {
  baseUrl: string;
}

export function SpecPanel({ baseUrl }: Props) {
  return (
    <div className="spec">
      <p>
        <a href={`${baseUrl}/docs`} target="_blank" rel="noreferrer">
          Open Swagger UI in a new tab
        </a>
        {" · "}
        <a href={`${baseUrl}/openapi.json`} target="_blank" rel="noreferrer">
          openapi.json
        </a>
      </p>
      <iframe className="spec-frame" title="OpenAPI docs" src={`${baseUrl}/docs`} />
    </div>
  );
}
