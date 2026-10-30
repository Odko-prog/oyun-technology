# Local desktop PDF fallback

`render-table-pdf.py` creates a PDF from supplied JSON using the desktop's existing
Python, ReportLab and pdfplumber. It is not wired into the Render worker, does not
poll or claim jobs, and never sends a message or file.

Before using it for a customer, reconcile the original conversation, cloud state
and intake ledger. Do not run competing work while cloud processing or device
approval owns the task. Do not resend an already delivered result.

Input fields: `title`, `headers`, `rows`, optional `paragraphs` and positive
`columnWeights`. All cell values must be strings. The helper supports at most
6 columns, 1000 rows and 120000 text characters. Text is escaped before layout;
it is not interpreted as ReportLab markup. Missing glyphs and unplaceable rows
fail instead of silently replacing text or dropping data.

```text
python render-table-pdf.py input.json result.pdf --font ../executor/fonts/DejaVuSans.ttf
```

The output directory must exist and the final filename must be unused. The helper
checks actual PDF text bounds before publishing a fully written file with an
exclusive same-filesystem link. It returns bytes, SHA256 and automated layout
metadata. It never marks visual QA as passed.

Before delivery, independently compare every requested value with the source,
render **every** page using Poppler, and inspect wrapping, repeated headings,
page breaks and glyphs. Save minimal hash/bytes/QA metadata, then use the existing
ledger preflight and single-send procedure in the exact source conversation.
Keep raw private source JSON and render images out of shared logs and Git.

This is structured table generation, not Word conversion, a DOCX renderer,
arbitrary equation typesetting, image editing, or proof of cloud/customer E2E.
The 84-row Mongolian fixture was rendered and inspected locally in four pages;
actual customer delivery remains a separate acceptance gate.
