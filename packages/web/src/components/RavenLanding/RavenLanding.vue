<script setup lang="ts">
// A raven resting on a hairline: the mark of a session that has finished. With `landing` it first glides in from the
// left on a shallow arc, three soft beats, and settles in about a second. It plays once, when the component mounts or
// `landing` turns on, and never loops. Same glyph family as the flock's ravens (styles/raven-glyphs.css).
withDefaults(defineProps<{ landing?: boolean }>(), { landing: false })
</script>

<template>
  <span class="iu-raven-land" :class="{ 'is-landing': landing }" aria-hidden="true">
    <i class="iu-raven-land__ground" />
    <i v-if="landing" class="iu-raven-land__fly" />
    <i class="iu-raven-land__sit" />
  </span>
</template>

<style>
.iu-raven-land {
  position: relative;
  display: block;
  width: 64px;
  height: 36px;
  flex: none;
}
.iu-raven-land > i {
  position: absolute;
  left: 50%;
  top: 50%;
  display: block;
  background: var(--iu-text-2);
}
.iu-raven-land__ground {
  width: 28px;
  height: 1px;
  margin: 8px 0 0 -14px;
  background: var(--iu-border) !important;
}
.iu-raven-land__sit {
  width: 16px;
  height: 12px;
  margin: -6px 0 0 -8px;
  opacity: 0.9;
  -webkit-mask: var(--rv-sit) center / contain no-repeat;
  mask: var(--rv-sit) center / contain no-repeat;
}
.iu-raven-land__fly {
  width: 20px;
  height: 14px;
  margin: -7px 0 0 -10px;
  opacity: 0;
  -webkit-mask: var(--rv-fly-mid) center / contain no-repeat;
  mask: var(--rv-fly-mid) center / contain no-repeat;
  animation:
    iu-raven-glide 0.95s linear 1 both,
    iu-raven-beat 0.95s linear 1 both;
}
.is-landing .iu-raven-land__sit {
  animation: iu-raven-sit 0.95s linear 1 both;
}
@keyframes iu-raven-glide {
  0% {
    opacity: 0;
    transform: translate(-34px, -16px) rotate(96deg);
  }
  8% {
    opacity: 0.9;
  }
  60% {
    transform: translate(-14px, -5px) rotate(92deg);
    animation-timing-function: var(--iu-ease);
  }
  92% {
    opacity: 0.9;
    transform: translate(0, 1px) rotate(84deg) scale(0.82);
  }
  100% {
    opacity: 0;
    transform: translate(0, 1px) rotate(84deg) scale(0.82);
  }
}
@keyframes iu-raven-beat {
  0%,
  10% {
    -webkit-mask-image: var(--rv-fly-mid);
    mask-image: var(--rv-fly-mid);
  }
  22% {
    -webkit-mask-image: var(--rv-fly-up);
    mask-image: var(--rv-fly-up);
  }
  34% {
    -webkit-mask-image: var(--rv-fly-mid);
    mask-image: var(--rv-fly-mid);
  }
  46% {
    -webkit-mask-image: var(--rv-fly-down);
    mask-image: var(--rv-fly-down);
  }
  58% {
    -webkit-mask-image: var(--rv-fly-mid);
    mask-image: var(--rv-fly-mid);
  }
  70% {
    -webkit-mask-image: var(--rv-fly-up);
    mask-image: var(--rv-fly-up);
  }
  82%,
  100% {
    -webkit-mask-image: var(--rv-fly-mid);
    mask-image: var(--rv-fly-mid);
  }
}
@keyframes iu-raven-sit {
  0%,
  92% {
    opacity: 0;
    transform: translateY(-3px);
  }
  100% {
    opacity: 0.9;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .iu-raven-land__fly {
    display: none;
  }
  .is-landing .iu-raven-land__sit {
    animation: none;
  }
}
</style>
