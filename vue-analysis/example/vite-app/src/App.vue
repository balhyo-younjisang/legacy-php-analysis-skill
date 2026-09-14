<template>
  <div class="app">
    <HelloWorld :name="userName" @greet="onGreet" />
    <CompositionWidget />
    <UnknownWidget />
    <button @click="refresh">Refresh</button>
  </div>
</template>

<script>
import axios from 'axios';
import HelloWorld from './components/HelloWorld.vue';
import CompositionWidget from './components/CompositionWidget.vue';

export default {
  name: 'App',
  components: { HelloWorld, CompositionWidget },

  data() {
    return {
      userName: 'Yuni',
      products: [],
    };
  },

  computed: {
    /**
     * Number of loaded products.
     */
    productCount() {
      return this.products.length;
    },
  },

  methods: {
    /**
     * Reload the product list from the API.
     * @returns {Promise<void>}
     */
    async refresh() {
      const res = await axios.get('/api/products');
      this.products = res.data;
      this.$store.dispatch('cart/sync');
    },

    // no docblock on purpose - a Spec gap
    onGreet(payload) {
      console.log('greeted:', payload);
      this.$emit('app-greeted', payload);
    },
  },

  created() {
    this.refresh();
  },
};
</script>
