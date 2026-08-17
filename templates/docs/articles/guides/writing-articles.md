# Writing Articles

Every article is a markdown file plus one entry in `data/docs.yaml`.

## Add an article

1. Create the file, e.g. `articles/guides/my-guide.md`.
2. Add it to the group's `items` in `data/docs.yaml`:

```yaml
- name: "My Guide"
  path: "my-guide"
  icon: "lucide:sparkles"
  doc: "/articles/guides/my-guide.md"
```

The sidebar, mobile navigation, search index, group landing page and
breadcrumbs all read from that one entry.

## Headings

`h2` and `h3` headings become the "On this page" list automatically.
