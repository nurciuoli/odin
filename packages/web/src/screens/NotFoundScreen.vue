<script setup lang="ts">
import { IuButton } from '@/components/Button'
import { IuEmpty } from '@/components/States'
</script>

<template>
  <div class="screen-center">
    <IuEmpty
      kind="filtered"
      title="Nothing at this address"
      body="That page doesn't exist in Odin."
    >
      <template #action>
        <IuButton as="router-link" to="/" variant="secondary">Back to projects</IuButton>
      </template>
    </IuEmpty>
  </div>
</template>

<style>
.screen-center {
  max-width: 560px;
  margin: 8vh auto 0;
}
</style>
