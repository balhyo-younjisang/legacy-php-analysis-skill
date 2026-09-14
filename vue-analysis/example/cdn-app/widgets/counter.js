/**
 * Global "counter" widget, registered on the CDN build of Vue.
 * Legacy pattern: no bundler, no SFC - just Vue.component() + a template string.
 */
Vue.component('counter', {
  template: '<button @click="increment">Clicks: {{ count }}</button>',

  props: {
    start: { type: Number, default: 0 },
  },

  data() {
    return { count: this.start };
  },

  methods: {
    /**
     * Increment the click counter and tell the page about it.
     */
    increment() {
      this.count++;
      this.$emit('counted', this.count);
    },

    // undocumented on purpose
    reset() {
      this.count = 0;
    },
  },
});
