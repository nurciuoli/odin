<script setup lang="ts">
import { computed, h, type VNode, type VNodeChild } from 'vue'
import IuCodeBlock from '@/components/CodeBlock/CodeBlock.vue'
import { parseMarkdown, type Block, type Inline, type ListBlock } from './parse'

const props = withDefaults(
  defineProps<{
    source: string
    streaming?: boolean
    /** file preview: h1-h6 and reflowed paragraphs instead of chat prose */
    document?: boolean
    size?: 'sm' | 'md'
    codeMaxHeight?: string
    /** names that render as @mentions; anything else after an @ stays literal */
    mentions?: string[]
    /** the current user's name: its mentions get the stronger "you" tint */
    self?: string
  }>(),
  {
    streaming: false,
    document: false,
    size: 'md',
    codeMaxHeight: '420px',
    mentions: () => [],
  },
)

const blocks = computed(() =>
  parseMarkdown(props.source, {
    streaming: props.streaming,
    mentions: props.mentions,
    document: props.document,
  }),
)

// Everything is built with h() from the parsed tree. No source string is ever
// interpreted as HTML, so raw tags in a message stay visible as text.
function caret(): VNode {
  return h('span', { class: 'iu-md__caret', 'aria-hidden': 'true' })
}

function inlines(nodes: Inline[]): VNodeChild[] {
  return nodes.map((n): VNodeChild => {
    switch (n.kind) {
      case 'text':
        return n.value
      case 'break':
        return h('br')
      case 'code':
        return h('code', { class: 'iu-md__code' }, n.value)
      case 'emphasis':
        return h('em', null, inlines(n.children))
      case 'strong':
        return h('strong', null, inlines(n.children))
      case 'mention': {
        const isSelf = !!props.self && n.name.toLowerCase() === props.self.toLowerCase()
        return h(
          'span',
          { class: 'iu-md__mention', 'data-self': isSelf ? '' : undefined },
          `@${n.name}`,
        )
      }
      case 'link': {
        const external = /^https?:/i.test(n.href)
        return h(
          'a',
          {
            class: 'iu-md__link',
            href: n.href,
            ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
          },
          inlines(n.children),
        )
      }
    }
  })
}

// `tail` marks the block that ends the message; it is where the caret goes while streaming.
function renderBlocks(list: Block[], tail: boolean): VNodeChild[] {
  return list.flatMap((b, idx) => renderBlock(b, tail && idx === list.length - 1))
}

function renderBlock(b: Block, tail: boolean): VNodeChild[] {
  switch (b.kind) {
    case 'paragraph': {
      const kids = inlines(b.children)
      if (tail) kids.push(caret())
      return [h('p', null, kids)]
    }
    case 'heading': {
      const kids = inlines(b.children)
      if (tail) kids.push(caret())
      return [h(`h${b.level}`, { class: `iu-md__h${b.level}` }, kids)]
    }
    case 'code':
      return [
        h(IuCodeBlock, {
          code: b.value,
          language: b.lang || undefined,
          maxHeight: props.codeMaxHeight,
        }),
        ...(tail ? [caret()] : []),
      ]
    case 'rule':
      return [h('hr', { class: 'iu-md__rule' }), ...(tail ? [caret()] : [])]
    case 'quote':
      return [h('blockquote', { class: 'iu-md__quote' }, renderBlocks(b.blocks, tail))]
    case 'list':
      return [renderList(b, tail, false)]
  }
}

function renderList(list: ListBlock, tail: boolean, nested: boolean): VNode {
  const items = list.items.map((item, k) => {
    const last = tail && k === list.items.length - 1
    const kids = inlines(item.children)
    if (last && !item.nested) kids.push(caret())
    if (item.nested) kids.push(renderList(item.nested, last, true))
    return h('li', null, kids)
  })
  return h(
    list.ordered ? 'ol' : 'ul',
    {
      class: nested ? 'iu-md__list iu-md__list--nested' : 'iu-md__list',
      start: list.ordered && list.start !== 1 ? list.start : undefined,
    },
    items,
  )
}

function Body() {
  const kids = renderBlocks(blocks.value, props.streaming)
  if (props.streaming && blocks.value.length === 0) kids.push(caret())
  return kids
}
</script>

<template>
  <div class="iu-md" :class="[`iu-md--${size}`, { 'iu-md--document': document }]">
    <Body />
  </div>
</template>

<style>
/* Chat prose. Body text is 14px (md) or 13px (sm); code blocks keep their own mono size. */
.iu-md {
  min-width: 0;
  color: var(--iu-text);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-14);
  line-height: var(--iu-leading-relaxed);
  overflow-wrap: anywhere;
}

.iu-md--sm {
  font-size: var(--iu-font-size-13);
}

/* margins are set by the flow below, never by the element defaults */
.iu-md :where(p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, hr) {
  margin: 0;
}

.iu-md > * + * {
  margin-top: 0.75em;
}
.iu-md > * + .iu-md__h3 {
  margin-top: 1.1em;
}
.iu-md > * + .iu-md__h4 {
  margin-top: 1em;
}
.iu-md > .iu-md__caret {
  margin: 0;
}

.iu-md__h3 {
  font-size: 15px;
  font-weight: var(--iu-font-weight-semibold);
  line-height: var(--iu-leading-snug);
  letter-spacing: -0.005em;
}

.iu-md__h4 {
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
  line-height: var(--iu-leading-snug);
}

/* file preview: a document, not chat prose */
.iu-md--document {
  max-width: 78ch;
  padding: 20px 16px 48px;
}
.iu-md--document > * + :where(.iu-md__h1, .iu-md__h2) {
  margin-top: 1.6em;
}
.iu-md--document .iu-md__h1,
.iu-md--document .iu-md__h2 {
  font-size: var(--iu-font-size-24);
  font-weight: var(--iu-font-weight-semibold);
  line-height: var(--iu-leading-snug);
}
.iu-md--document .iu-md__h2 {
  font-size: 20px;
}
.iu-md--document .iu-md__h5,
.iu-md--document .iu-md__h6 {
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.iu-md--document > * + :where(.iu-md__h5, .iu-md__h6) {
  margin-top: 1em;
}

.iu-md strong {
  font-weight: var(--iu-font-weight-semibold);
}

.iu-md__code {
  font-family: var(--iu-font-mono);
  font-size: 0.9em;
  color: var(--iu-text);
  background: var(--iu-well);
  border: 1px solid var(--iu-hairline);
  border-radius: var(--iu-radius-sm);
  padding: 0.1em 0.35em;
}

/* underlined by default so links read as links without relying on hue alone */
.iu-md__link {
  color: var(--iu-accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--iu-accent) 45%, transparent);
  text-underline-offset: 3px;
}

.iu-md__link:hover {
  text-decoration-color: var(--iu-accent);
}

.iu-md__link:focus-visible {
  outline: 1px solid var(--iu-accent);
  outline-offset: 1px;
  border-radius: var(--iu-radius-sm);
}

.iu-md ul,
.iu-md ol {
  padding-left: 1.35em;
}

.iu-md__list > li + li {
  margin-top: 0.3em;
}

.iu-md__list > li::marker {
  color: var(--iu-text-muted);
}

.iu-md__list--nested {
  margin-top: 0.3em;
}

.iu-md__quote {
  padding-left: 12px;
  border-left: 2px solid var(--iu-border-strong);
  color: var(--iu-text-2);
}

.iu-md__rule {
  height: 0;
  border: 0;
  border-top: 1px solid var(--iu-hairline);
}

/* a mention is a tinted label, not a link: the @ stays so it reads without the colour */
.iu-md__mention {
  padding: 0 3px;
  border-radius: var(--iu-radius-sm);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-accent-ink);
  background: color-mix(in srgb, var(--iu-accent) 14%, transparent);
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

.iu-md__mention[data-self] {
  background: color-mix(in srgb, var(--iu-accent) 22%, transparent);
}

/* streaming caret: a solid block that blinks in steps, never animates for reduced motion */
.iu-md__caret {
  display: inline-block;
  width: 0.55em;
  height: 1.1em;
  margin-left: 0.1em;
  vertical-align: -0.2em;
  background: var(--iu-accent);
  animation: iu-md-caret 1s steps(2) infinite;
}

@keyframes iu-md-caret {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .iu-md__caret {
    animation: none;
  }
}
</style>
