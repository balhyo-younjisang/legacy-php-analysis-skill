<template>
  <div class="hello">
    <h1>Hello, {{ name }}</h1>
  </div>
</template>

<script>
/**
 * Simple greeting banner. Emits "greet" once mounted.
 */
export default {
  name: 'HelloWorld',

  props: {
    name: { type: String, required: true },
  },

  emits: ['greet'],

  mounted() {
    this.$emit('greet', { name: this.name });
  },
};
</script>
