import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CsvViewer from './CsvViewer.vue'

it('detects TSV on first mount and emits original selected records', async () => {
  const wrapper = mount(CsvViewer, {
    props: { source: 'id\tname\n001\tAlice', filename: 'data.tsv' },
  })
  expect(wrapper.find('select').element.value).toBe('\t')
  expect(wrapper.findAll('thead th').map(cell => cell.text())).toContain('name')
  await wrapper.find('tbody input[type=checkbox]').setValue(true)
  await wrapper
    .findAll('button')
    .find(button => button.text() === 'Send selected rows')!
    .trigger('click')
  expect(wrapper.emitted('selection')?.[0]?.[0]).toEqual({
    delimiter: '\t',
    rows: [{ record: 2, line: 2, values: ['001', 'Alice'] }],
  })
  wrapper.unmount()
})
