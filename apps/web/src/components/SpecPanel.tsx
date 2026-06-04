interface Props {
  baseUrl: string;
}

export function SpecPanel({ baseUrl }: Props) {
  return (
    <div className="spec">
      <p>
        <a href={`${baseUrl}/docs`} target="_blank" rel="noreferrer">
          在新标签打开 Swagger UI
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
