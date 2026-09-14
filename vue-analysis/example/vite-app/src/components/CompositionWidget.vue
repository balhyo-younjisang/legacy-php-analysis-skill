<template>
  <div class="composition-widget">{{ label }}</div>
</template>

<script setup>
// Composition API (script setup) - deliberately mixed into an otherwise
// Options-API codebase, to prove the extractor doesn't crash on it and
// degrades gracefully (see SKILL.md Gotchas: no deep ref()/reactive()
// extraction is attempted for this style).
import { ref } from 'vue';

const label = ref('composition widget');
</script>
