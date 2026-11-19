<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { IuButton } from '@/components/Button'
import { detectDelimiter, parseCsv, type CsvSelection } from './csv'
const props = withDefaults(defineProps<{ source: string; filename?: string }>(), { filename: '' })
const emit = defineEmits<{ selection: [value: CsvSelection] }>()
const delimiter = ref(',')
const headers = ref(true)
const query = ref('')
const page = ref(0)
const sort = ref(-1)
const descending = ref(false)
const selected = ref(new Set<number>())
watch(
  () => props.source,
  () => {
    delimiter.value = detectDelimiter(props.source, props.filename)
    selected.value = new Set()
    page.value = 0
  },
  { immediate: true },
)
const parsed = computed(() => parseCsv(props.source, delimiter.value))
const columns = computed(() => Math.max(0, ...parsed.value.rows.map(r => r.values.length)))
const labels = computed(() =>
  Array.from({ length: columns.value }, (_, i) =>
    headers.value ? parsed.value.rows[0]?.values[i] || `Column ${i + 1}` : `Column ${i + 1}`,
  ),
)
const rows = computed(() => {
  const found = parsed.value.rows
    .slice(headers.value ? 1 : 0)
    .filter(
      r => !query.value || r.values.some(v => v.toLowerCase().includes(query.value.toLowerCase())),
    )
  if (sort.value >= 0)
    found.sort(
      (a, b) =>
        (a.values[sort.value] ?? '').localeCompare(b.values[sort.value] ?? '') *
        (descending.value ? -1 : 1),
    )
  return found
})
const visible = computed(() => rows.value.slice(page.value * 100, (page.value + 1) * 100))
watch([query, delimiter, headers, sort, descending], () => {
  page.value = 0
})
function order(column: number) {
  if (sort.value === column) descending.value = !descending.value
  else {
    sort.value = column
    descending.value = false
  }
}
function toggle(record: number) {
  const next = new Set(selected.value)
  if (next.has(record)) next.delete(record)
  else next.add(record)
  selected.value = next
}
function send() {
  emit('selection', {
    rows: parsed.value.rows.filter(r => selected.value.has(r.record)),
    delimiter: delimiter.value,
  })
}
</script>
<template>
  <section class="iu-csv" aria-label="CSV viewer">
    <div class="iu-csv__toolbar">
      <label
        >Delimiter
        <select v-model="delimiter" aria-label="Delimiter">
          <option value=",">Comma</option>
          <option :value="'\t'">Tab</option>
          <option value=";">Semicolon</option>
          <option value="|">Pipe</option>
        </select></label
      >
      <label><input v-model="headers" type="checkbox" /> First row is headers</label>
      <label>Filter <input v-model="query" type="search" aria-label="Filter rows" /></label>
      <IuButton size="sm" :disabled="!selected.size" @click="send">Send selected rows</IuButton>
    </div>
    <p role="status">
      {{ rows.length }} rows · {{ columns }} columns. Values are text; sorting and filtering affect
      this view only.
    </p>
    <p v-if="parsed.truncated || parsed.truncatedColumns" role="status">
      Partial preview: at most 10,000 records and 200 columns. Search and sorting cover loaded
      records only.
    </p>
    <p v-for="error in parsed.errors" :key="error" role="alert">{{ error }}</p>
    <div class="iu-csv__scroll" tabindex="0" aria-label="Scrollable CSV table">
      <table>
        <thead>
          <tr>
            <th scope="col">Select</th>
            <th scope="col">Record / line</th>
            <th
              v-for="(label, i) in labels"
              :key="i"
              scope="col"
              :aria-sort="sort === i ? (descending ? 'descending' : 'ascending') : 'none'"
            >
              <button type="button" @click="order(i)">{{ label }}</button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in visible" :key="row.record">
            <td>
              <input
                type="checkbox"
                :aria-label="`Select record ${row.record}`"
                :checked="selected.has(row.record)"
                @change="toggle(row.record)"
              />
            </td>
            <th scope="row">{{ row.record }} / {{ row.line }}</th>
            <td v-for="(_, i) in labels" :key="i" :data-missing="i >= row.values.length">
              {{ i >= row.values.length ? '—' : row.values[i] }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="iu-csv__toolbar">
      <IuButton size="sm" :disabled="page === 0" @click="page--">Previous</IuButton
      ><span>Page {{ page + 1 }} of {{ Math.max(1, Math.ceil(rows.length / 100)) }}</span
      ><IuButton size="sm" :disabled="(page + 1) * 100 >= rows.length" @click="page++"
        >Next</IuButton
      >
    </div>
  </section>
</template>
<style>
.iu-csv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 12px;
  padding: 12px;
  color: var(--iu-text);
  font-size: var(--iu-font-size-13);
}
.iu-csv__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.iu-csv p {
  margin: 0;
  color: var(--iu-text-muted);
}
.iu-csv input,
.iu-csv select,
.iu-csv th button {
  color: inherit;
  background: var(--iu-well);
  border: 1px solid var(--iu-border);
  font: inherit;
}
.iu-csv :focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.iu-csv__scroll {
  overflow: auto;
  max-height: 65vh;
}
.iu-csv table {
  border-collapse: collapse;
  text-align: left;
}
.iu-csv td,
.iu-csv th {
  padding: 8px;
  border-bottom: 1px solid var(--iu-border-quiet);
  white-space: pre-wrap;
  min-width: 80px;
  max-width: 400px;
  overflow-wrap: anywhere;
}
.iu-csv thead th {
  position: sticky;
  top: 0;
  background: var(--iu-ground);
}
.iu-csv td {
  font-family: var(--iu-font-mono);
}
.iu-csv th {
  font-weight: var(--iu-font-weight-medium);
}
.iu-csv td[data-missing='true'] {
  color: var(--iu-text-muted);
}
</style>
