/**
 * Swipe Card Lite - Lightweight swipe carousel card for Home Assistant
 * Uses native CSS scroll-snap for smooth swiping with infinite loop support
 */

const VERSION = '2.2.2';

class SwipeCardLite extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._cards = [];        // Real card elements
    this._allSlideCards = []; // All cards including clones
    this._currentIndex = 0;   // DOM index (includes clone offset)
    this._realIndex = 0;      // Actual card index (0 to cards.length-1)
    this._initialized = false;
    this._scrollTimeout = null;
    this._resetTimeout = null;
    this._paginationHideTimeout = null;
    this._stateUpdateInProgress = false;
    this._buildId = 0;        // Track build attempts to prevent race conditions
    this._isInfiniteMode = false;
    this._jumping = false;
    this._userScrolling = false;  // Track active user scrolling to prevent sync conflicts
    this._scrollSettleTimeout = null;
    this._rafPending = false;  // RAF throttle flag for scroll handler
    this._cachedPagination = null;  // Cached pagination element
    this._cachedScroller = null;    // Cached scroller element
    this._lastSyncedValue = null;   // Track last value synced to state entity
    this._syncedAt = 0;             // Timestamp of last sync
  }

  setConfig(config) {
    if (!config.cards || !Array.isArray(config.cards)) {
      throw new Error('Please define cards');
    }

    this._config = {
      cards: config.cards || [],
      show_pagination: config.show_pagination !== false,
      start_card: config.start_card ?? 1,
      loop_mode: config.loop_mode ?? 'none',
      state_entity: config.state_entity ?? null,
      auto_hide_pagination: config.auto_hide_pagination ?? 0,
      enable_reset_after: config.enable_reset_after ?? false,
      reset_after_timeout: config.reset_after_timeout ?? 30000,
      reset_target_card: config.reset_target_card ?? 1,
      slide_width: config.slide_width ?? null,
      slide_height: config.slide_height ?? null,
      slide_padding: config.slide_padding ?? null,
      slide_gap: config.slide_gap ?? null,
      show_version: config.show_version ?? false,
      border_radius: config.border_radius ?? null,
      // Entity to pause auto-reset (when 'off', auto-reset is paused)
      auto_reset_enabled_entity: config.auto_reset_enabled_entity ?? null,
    };

    console.log('[swipe-card-lite] setConfig called, loop_mode:', this._config.loop_mode);

    if (this._hass && !this._initialized) {
      this._buildCards();
    }
  }

  set hass(hass) {
    const oldHass = this._hass;
    this._hass = hass;

    // Pass hass to all cards including clones
    // Use 'hass' in card check to properly detect setter, not value check
    this._allSlideCards.forEach(card => {
      if (card && 'hass' in card) {
        card.hass = hass;
      }
    });

    if (!this._initialized && this._config) {
      this._buildCards();
    }

    if (this._config?.state_entity && this._initialized && !this._stateUpdateInProgress) {
      this._syncFromStateEntity(oldHass, hass);
    }

    // Check if auto-reset entity changed to 'on' - restart timer
    if (this._config?.auto_reset_enabled_entity && this._initialized) {
      const entity = this._config.auto_reset_enabled_entity;
      const oldState = oldHass?.states?.[entity]?.state;
      const newState = hass?.states?.[entity]?.state;
      if (newState === 'on' && oldState !== 'on') {
        this._resetResetTimer();
      }
    }
  }

  _isAutoResetEnabled() {
    const entity = this._config?.auto_reset_enabled_entity;
    if (!entity) return true; // No entity configured = always enabled
    const state = this._hass?.states?.[entity]?.state;
    return state === 'on';
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (this._config?.enable_reset_after) {
      this._resetResetTimer();
    }
  }

  disconnectedCallback() {
    if (this._resetTimeout) clearTimeout(this._resetTimeout);
    if (this._paginationHideTimeout) clearTimeout(this._paginationHideTimeout);
    if (this._scrollTimeout) clearTimeout(this._scrollTimeout);
    if (this._scrollSettleTimeout) clearTimeout(this._scrollSettleTimeout);
    // Clear cached element references
    this._cachedPagination = null;
    this._cachedScroller = null;
    this._rafPending = false;
  }

  async _buildCards() {
    if (!this._config || !this._hass) return;

    // Prevent concurrent builds with build ID
    const thisBuildId = ++this._buildId;

    // If already initialized, don't rebuild
    if (this._initialized) return;

    const helpers = await this._loadCardHelpers();

    // Check if another build started while we were waiting
    if (thisBuildId !== this._buildId) return;

    // Build real cards
    this._cards = [];
    for (const cardConfig of this._config.cards) {
      try {
        const card = await helpers.createCardElement(cardConfig);
        card.hass = this._hass;
        this._cards.push(card);
      } catch (e) {
        console.error('Error creating card:', e);
        const errorCard = document.createElement('ha-card');
        errorCard.innerHTML = `<div style="padding: 16px; color: var(--error-color);">Error: ${e.message}</div>`;
        this._cards.push(errorCard);
      }
    }

    // Check if build was superseded
    if (thisBuildId !== this._buildId) return;

    // Check if infinite mode
    const loopMode = this._config.loop_mode;
    this._isInfiniteMode = (loopMode === 'infinite' || loopMode === 'loopback') && this._cards.length > 1;

    console.log('[swipe-card-lite] loop_mode:', loopMode, 'isInfiniteMode:', this._isInfiniteMode, 'cards:', this._cards.length);

    // Build clone cards for infinite mode
    this._allSlideCards = [...this._cards];

    if (this._isInfiniteMode) {
      // Create clone of last card (will go at beginning)
      const lastCardConfig = this._config.cards[this._config.cards.length - 1];
      const cloneOfLast = await helpers.createCardElement(lastCardConfig);
      cloneOfLast.hass = this._hass;

      // Create clone of first card (will go at end)
      const firstCardConfig = this._config.cards[0];
      const cloneOfFirst = await helpers.createCardElement(firstCardConfig);
      cloneOfFirst.hass = this._hass;

      // Array: [cloneOfLast, ...realCards, cloneOfFirst]
      this._allSlideCards = [cloneOfLast, ...this._cards, cloneOfFirst];

      console.log('[swipe-card-lite] Created clones, total slides:', this._allSlideCards.length);
    }

    // Final check before rendering
    if (thisBuildId !== this._buildId) return;

    this._render();
    this._initialized = true;

    // Start pagination auto-hide timer if configured
    if (this._config.auto_hide_pagination > 0) {
      this._startPaginationHideTimer();
    }
  }

  async _loadCardHelpers() {
    if (window.loadCardHelpers) {
      return window.loadCardHelpers();
    }
    return {
      createCardElement: async (config) => {
        const tag = config.type.startsWith('custom:')
          ? config.type.substr(7)
          : `hui-${config.type}-card`;
        const element = document.createElement(tag);
        if (element.setConfig) element.setConfig(config);
        return element;
      }
    };
  }

  _render() {
    const showPagination = this._config.show_pagination && this._cards.length > 1;

    // Calculate initial position before rendering
    let startRealIndex = Math.max(0, (this._config.start_card || 1) - 1);
    if (this._config.state_entity && this._hass?.states[this._config.state_entity]) {
      const stateValue = this._hass.states[this._config.state_entity].state;
      const entityIndex = parseInt(stateValue, 10);
      if (!isNaN(entityIndex) && entityIndex >= 1 && entityIndex <= this._cards.length) {
        startRealIndex = entityIndex - 1;
      }
    }
    this._realIndex = startRealIndex;
    let startDomIndex = this._isInfiniteMode ? startRealIndex + 1 : startRealIndex;
    this._currentIndex = startDomIndex;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          position: relative;
          isolation: isolate;
          /* Contain layout/paint to isolate from rest of page */
          contain: layout style;
        }
        .scroll-container {
          display: flex;
          overflow-x: auto;
          overflow-y: hidden;
          scroll-snap-type: none; /* Disabled initially */
          scroll-behavior: auto;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
          -ms-overflow-style: none;
          will-change: scroll-position;
          transform: translateZ(0);
          /* Tell browser exactly what touch gestures to expect */
          touch-action: pan-x;
          /* Prevent scroll chaining to parent elements */
          overscroll-behavior-x: contain;
        }
        .scroll-container.snap-enabled {
          scroll-snap-type: x mandatory;
        }
        .scroll-container::-webkit-scrollbar {
          display: none;
        }
        .slide {
          flex: 0 0 ${this._config.slide_width || '100%'};
          width: ${this._config.slide_width || '100%'};
          ${this._config.slide_height ? `height: ${this._config.slide_height};` : 'min-height: 100px;'}
          ${this._config.slide_padding ? `padding: ${this._config.slide_padding}; box-sizing: border-box;` : ''}
          scroll-snap-align: start;
          scroll-snap-stop: always;
          ${this._config.border_radius ? `border-radius: ${this._config.border_radius}; overflow: hidden;` : ''}
          ${this._config.slide_gap ? `margin-right: ${this._config.slide_gap};` : ''}
          /* Promote each slide to its own compositing layer */
          will-change: transform;
        }
        .slide:last-child {
          margin-right: 0;
        }
        .slide > * {
          width: 100%;
          height: 100%;
        }
        .pagination {
          display: ${showPagination ? 'flex' : 'none'};
          justify-content: center;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          position: absolute;
          bottom: 12px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 10;
          pointer-events: none;
          /* No background by default - just dots */
          background: transparent;
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          border-radius: 100px;
          border: 1px solid transparent;
          /* Smooth transition for pill appearing */
          transition: opacity 0.3s ease-out, background 0.2s ease-out, border-color 0.2s ease-out, backdrop-filter 0.2s ease-out, -webkit-backdrop-filter 0.2s ease-out;
        }
        .pagination.hidden {
          opacity: 0;
        }
        .pagination.scrolling {
          /* Frosted pill appears while swiping */
          background: rgba(255, 255, 255, 0.18);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border-color: rgba(255, 255, 255, 0.1);
        }
        .pagination-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.5);
          cursor: pointer;
          pointer-events: auto;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
          /* Smooth transitions */
          transition: background-color 0.2s ease, transform 0.2s ease, opacity 0.2s ease, filter 0.2s ease;
        }
        .pagination-dot.active {
          background: rgba(255, 255, 255, 0.95);
          transform: scale(1.2);
        }
        .version-overlay {
          position: absolute;
          top: 4px;
          right: 4px;
          font-size: 9px;
          color: rgba(255,255,255,0.4);
          background: rgba(0,0,0,0.2);
          padding: 2px 5px;
          border-radius: 3px;
          z-index: 10;
          pointer-events: none;
          font-family: monospace;
        }
      </style>

      <div class="scroll-container" id="scroller">
        ${this._allSlideCards.map((_, i) => `<div class="slide" data-index="${i}"></div>`).join('')}
      </div>

      ${showPagination ? `
        <div class="pagination" id="pagination">
          ${this._cards.map((_, i) => `<div class="pagination-dot ${i === startRealIndex ? 'active' : ''}" data-index="${i}"></div>`).join('')}
        </div>
      ` : ''}

      ${this._config.show_version ? `<div class="version-overlay">v${VERSION}</div>` : ''}
    `;

    // Insert cards into slides
    const slides = this.shadowRoot.querySelectorAll('.slide');
    this._allSlideCards.forEach((card, i) => {
      if (slides[i]) slides[i].appendChild(card);
    });

    const scroller = this.shadowRoot.getElementById('scroller');
    if (scroller) {
      // Set initial scroll position immediately (before snap is enabled)
      const setInitialPosition = () => {
        const slideWidth = this._getSlideWidth();
        if (slideWidth > 0) {
          scroller.scrollLeft = startDomIndex * slideWidth;
          // Enable scroll-snap after position is set
          requestAnimationFrame(() => {
            scroller.classList.add('snap-enabled');
          });
        } else {
          // Retry if not ready
          requestAnimationFrame(setInitialPosition);
        }
      };
      requestAnimationFrame(setInitialPosition);

      // Setup scroll listener
      scroller.addEventListener('scroll', this._handleScroll.bind(this), { passive: true });

      // Track user scrolling to prevent state sync conflicts
      const onScrollStart = () => {
        this._userScrolling = true;
        if (this._scrollSettleTimeout) clearTimeout(this._scrollSettleTimeout);
        this._showPagination();
        if (this._config.enable_reset_after) this._resetResetTimer();
      };

      scroller.addEventListener('touchstart', onScrollStart, { passive: true });
      scroller.addEventListener('mousedown', onScrollStart, { passive: true });
      scroller.addEventListener('touchend', () => {
        if (this._config.auto_hide_pagination > 0) this._startPaginationHideTimer();
      }, { passive: true });
    }

    // Pagination click handlers (use real index)
    this.shadowRoot.querySelectorAll('.pagination-dot').forEach(dot => {
      dot.addEventListener('click', (e) => {
        const realIndex = parseInt(e.target.dataset.index, 10);
        this._goToRealIndex(realIndex, true);
      });
    });

    // Cache element references for performance
    this._cachedPagination = this.shadowRoot.getElementById('pagination');
    this._cachedScroller = this.shadowRoot.getElementById('scroller');
  }

  _getSlideWidth() {
    const slide = this.shadowRoot?.querySelector('.slide');
    if (!slide) return 0;
    // With CSS gap, we need to account for gap in scroll calculations
    // Get the actual distance between slide starts by checking positions
    const slides = this.shadowRoot?.querySelectorAll('.slide');
    if (slides && slides.length > 1) {
      return slides[1].offsetLeft - slides[0].offsetLeft;
    }
    return slide.offsetWidth;
  }

  _handleScroll() {
    if (this._jumping) return;

    // Mark as user scrolling to prevent state sync bounce-back
    this._userScrolling = true;
    if (this._scrollSettleTimeout) clearTimeout(this._scrollSettleTimeout);

    // Throttle to once per animation frame for performance
    if (this._rafPending) return;
    this._rafPending = true;

    requestAnimationFrame(() => {
      this._rafPending = false;
      if (this._jumping) return;

      // Use cached pagination element - no DOM query during scroll
      const pagination = this._cachedPagination;
      if (pagination) {
        pagination.classList.remove('hidden');
        if (!pagination.classList.contains('scrolling')) {
          pagination.classList.add('scrolling');
        }
      }
      if (this._paginationHideTimeout) clearTimeout(this._paginationHideTimeout);

      // Update pagination dot in real-time based on scroll position
      const scroller = this._cachedScroller;
      if (scroller) {
        const slideWidth = this._getSlideWidth();
        if (slideWidth > 0) {
          const scrollPos = scroller.scrollLeft;
          const domIndex = Math.round(scrollPos / slideWidth);
          let realIndex = this._isInfiniteMode ? domIndex - 1 : domIndex;
          // Clamp to valid range (handle clone positions)
          realIndex = Math.max(0, Math.min(realIndex, this._cards.length - 1));
          if (realIndex !== this._realIndex) {
            this._realIndex = realIndex;
            this._currentIndex = domIndex;
            this._updatePagination();
          }
        }
      }

      if (this._scrollTimeout) clearTimeout(this._scrollTimeout);

      // Use longer timeout for slower devices
      this._scrollTimeout = setTimeout(() => {
        this._onScrollEnd();
      }, 150);
    });
  }

  _onScrollEnd() {
    if (this._jumping) return;

    const scroller = this._cachedScroller;
    if (!scroller) return;

    const slideWidth = this._getSlideWidth();
    if (slideWidth === 0) return;

    const scrollPos = scroller.scrollLeft;
    const exactIndex = scrollPos / slideWidth;
    const domIndex = Math.round(exactIndex);
    this._currentIndex = domIndex;

    if (this._isInfiniteMode) {
      const totalSlides = this._allSlideCards.length;
      const lastCloneIndex = totalSlides - 1;

      // Only trigger clone jump if we're very close to the clone position (within 0.1 of a slide)
      const tolerance = 0.1;

      // Check if on clone of last card (position 0)
      if (exactIndex < tolerance) {
        this._jumpToSlide(this._cards.length, this._cards.length - 1);
        return;
      }
      // Check if on clone of first card (last position)
      else if (exactIndex > lastCloneIndex - tolerance) {
        this._jumpToSlide(1, 0);
        return;
      }
      else {
        // Normal position - calculate real index (subtract 1 for leading clone)
        this._realIndex = domIndex - 1;
      }
    } else {
      this._realIndex = domIndex;
    }

    this._updatePagination();
    this._syncToStateEntity();
    if (this._config.enable_reset_after) this._resetResetTimer();
    if (this._config.auto_hide_pagination > 0) this._startPaginationHideTimer();

    // Remove scrolling class for CarPlay blur effect
    const pagination = this._cachedPagination;
    if (pagination) pagination.classList.remove('scrolling');

    // Clear user scrolling flag after state sync has time to propagate
    if (this._scrollSettleTimeout) clearTimeout(this._scrollSettleTimeout);
    this._scrollSettleTimeout = setTimeout(() => {
      this._userScrolling = false;
    }, 500);
  }

  _jumpToSlide(targetDomIndex, targetRealIndex) {
    const scroller = this._cachedScroller;
    if (!scroller) return;

    this._jumping = true;
    this._realIndex = targetRealIndex;
    this._currentIndex = targetDomIndex;

    const slideWidth = this._getSlideWidth();

    // Temporarily disable scroll-snap for instant jump
    scroller.classList.remove('snap-enabled');

    // Use scrollLeft directly for better compatibility
    scroller.scrollLeft = targetDomIndex * slideWidth;

    // Re-enable scroll-snap after jump
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scroller.classList.add('snap-enabled');
        this._jumping = false;
        this._updatePagination();
        this._syncToStateEntity();
        if (this._config.enable_reset_after) this._resetResetTimer();
        if (this._config.auto_hide_pagination > 0) this._startPaginationHideTimer();
        // Remove scrolling class for CarPlay blur effect
        const pagination = this._cachedPagination;
        if (pagination) pagination.classList.remove('scrolling');
      });
    });
  }

  _updatePagination() {
    const pagination = this._cachedPagination;
    if (!pagination) return;
    const dots = pagination.querySelectorAll('.pagination-dot');
    dots.forEach((dot, i) => dot.classList.toggle('active', i === this._realIndex));
  }

  _goToRealIndex(realIndex, smooth = true) {
    const scroller = this._cachedScroller;
    if (!scroller) return;

    // Clamp real index
    realIndex = Math.max(0, Math.min(realIndex, this._cards.length - 1));
    this._realIndex = realIndex;

    // Calculate DOM index
    let domIndex = realIndex;
    if (this._isInfiniteMode) {
      domIndex = realIndex + 1; // +1 for leading clone
    }

    const slideWidth = this._getSlideWidth();

    // If width is 0, DOM isn't ready - retry after a short delay
    if (slideWidth === 0) {
      setTimeout(() => this._goToRealIndex(realIndex, smooth), 50);
      return;
    }

    scroller.scrollTo({
      left: domIndex * slideWidth,
      behavior: smooth ? 'smooth' : 'instant'
    });

    this._currentIndex = domIndex;
    this._updatePagination();
  }

  // ===== State Entity Sync =====

  _syncFromStateEntity(oldHass, newHass) {
    const entity = this._config.state_entity;
    if (!entity) return;

    // Skip sync if user is actively scrolling - prevents bounce-back from our own state updates
    if (this._userScrolling) return;

    const newState = newHass?.states[entity]?.state;
    if (!newState) return;

    let targetIndex = parseInt(newState, 10);
    if (isNaN(targetIndex)) return;

    // input_number is 1-based
    const stateValue = targetIndex;
    if (entity.startsWith('input_number.')) {
      targetIndex = targetIndex - 1;
    }

    if (targetIndex < 0 || targetIndex >= this._cards.length) return;

    // Compare against current position, not old hass state
    // This ensures we react even if hass object references are reused
    if (targetIndex === this._realIndex) return;

    // Ignore state updates that match what we just synced (within 2 seconds)
    // This prevents bounce-back when HA echoes our own state change
    if (this._lastSyncedValue === stateValue && (Date.now() - this._syncedAt) < 2000) {
      return;
    }

    this._stateUpdateInProgress = true;
    this._goToRealIndex(targetIndex, true);
    this._stateUpdateInProgress = false;
  }

  _syncToStateEntity() {
    const entity = this._config.state_entity;
    if (!entity || !this._hass) return;

    if (entity.startsWith('input_number.')) {
      const targetValue = this._realIndex + 1; // 1-based
      const currentState = this._hass.states[entity]?.state;
      if (parseInt(currentState, 10) === targetValue) return;

      // Track what we're syncing to ignore bounce-back
      this._lastSyncedValue = targetValue;
      this._syncedAt = Date.now();

      this._hass.callService('input_number', 'set_value', {
        entity_id: entity,
        value: targetValue
      });
    }
  }

  // ===== Pagination Auto-Hide =====

  _showPagination() {
    const pagination = this._cachedPagination;
    if (pagination) pagination.classList.remove('hidden');
    if (this._paginationHideTimeout) clearTimeout(this._paginationHideTimeout);
  }

  _startPaginationHideTimer() {
    if (this._config.auto_hide_pagination <= 0) return;
    if (this._paginationHideTimeout) clearTimeout(this._paginationHideTimeout);

    this._paginationHideTimeout = setTimeout(() => {
      const pagination = this._cachedPagination;
      if (pagination) pagination.classList.add('hidden');
    }, this._config.auto_hide_pagination);
  }

  // ===== Reset After Timeout =====

  _resetResetTimer() {
    if (!this._config.enable_reset_after) return;
    if (this._resetTimeout) clearTimeout(this._resetTimeout);

    // Don't start timer if auto-reset is disabled by entity
    if (!this._isAutoResetEnabled()) return;

    this._resetTimeout = setTimeout(() => {
      // Check again when timer fires in case entity changed
      if (!this._isAutoResetEnabled()) return;

      const targetIndex = Math.max(0, (this._config.reset_target_card || 1) - 1);
      if (targetIndex !== this._realIndex && targetIndex < this._cards.length) {
        this._goToRealIndex(targetIndex, true);
        this._syncToStateEntity();
      }
    }, this._config.reset_after_timeout);
  }

  getCardSize() {
    let maxSize = 1;
    this._cards.forEach(card => {
      if (typeof card.getCardSize === 'function') {
        maxSize = Math.max(maxSize, card.getCardSize());
      }
    });
    return maxSize + (this._config.show_pagination ? 1 : 0);
  }

  static getConfigElement() {
    return document.createElement('swipe-card-lite-editor');
  }

  static getStubConfig() {
    return { cards: [{ type: 'markdown', content: 'Card 1' }, { type: 'markdown', content: 'Card 2' }] };
  }
}

// Editor
class SwipeCardLiteEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  get hass() {
    return this._hass;
  }

  _getCardTypeName(cardConfig) {
    if (!cardConfig) return 'Not configured';
    const type = cardConfig.type || 'unknown';
    return type.replace('custom:', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  _render() {
    const cards = this._config.cards || [];

    this.shadowRoot.innerHTML = `
      <style>
        .editor {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .section {
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          padding: 12px;
        }
        .section-title {
          font-weight: 500;
          margin-bottom: 12px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .card-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          background: var(--secondary-background-color);
          border-radius: 6px;
          margin-bottom: 8px;
        }
        .card-item:last-child {
          margin-bottom: 0;
        }
        .card-info {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          cursor: pointer;
        }
        .card-type {
          font-size: 14px;
          color: var(--primary-text-color);
        }
        .card-actions {
          display: flex;
          gap: 4px;
        }
        .card-actions ha-icon-button {
          --mdc-icon-button-size: 32px;
          --mdc-icon-size: 18px;
        }
        .add-card {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 12px;
          border: 2px dashed var(--divider-color);
          border-radius: 6px;
          cursor: pointer;
          color: var(--secondary-text-color);
          transition: all 0.2s;
          margin-top: 8px;
        }
        .add-card:hover {
          border-color: var(--primary-color);
          color: var(--primary-color);
        }
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 4px 0;
        }
        .row label {
          font-size: 14px;
        }
        ha-textfield {
          width: 120px;
        }
        ha-entity-picker {
          width: 200px;
        }
        .hint {
          font-size: 12px;
          color: var(--secondary-text-color);
          margin-top: 4px;
        }
      </style>
      <div class="editor">
        <!-- Cards Section -->
        <div class="section">
          <div class="section-title">
            <ha-icon icon="mdi:cards-outline"></ha-icon>
            Slides
          </div>
          <div id="cards-list">
            ${cards.map((card, i) => `
              <div class="card-item" data-index="${i}">
                <div class="card-info" data-action="edit" data-index="${i}">
                  <ha-icon icon="mdi:drag-vertical"></ha-icon>
                  <span class="card-type">${this._getCardTypeName(card)}</span>
                </div>
                <div class="card-actions">
                  <ha-icon-button data-action="move-up" data-index="${i}" ${i === 0 ? 'disabled' : ''}>
                    <ha-icon icon="mdi:arrow-up"></ha-icon>
                  </ha-icon-button>
                  <ha-icon-button data-action="move-down" data-index="${i}" ${i === cards.length - 1 ? 'disabled' : ''}>
                    <ha-icon icon="mdi:arrow-down"></ha-icon>
                  </ha-icon-button>
                  <ha-icon-button data-action="delete" data-index="${i}">
                    <ha-icon icon="mdi:delete"></ha-icon>
                  </ha-icon-button>
                </div>
              </div>
            `).join('')}
          </div>
          <div class="add-card" id="add-card">
            <ha-icon icon="mdi:plus"></ha-icon>
            <span>Add Card</span>
          </div>
        </div>

        <!-- Behavior Section -->
        <div class="section">
          <div class="section-title">
            <ha-icon icon="mdi:gesture-swipe-horizontal"></ha-icon>
            Behavior
          </div>

          <div class="row">
            <label>Infinite loop</label>
            <ha-switch id="infinite_loop" ${this._config.loop_mode === 'infinite' ? 'checked' : ''}></ha-switch>
          </div>

          <div class="row">
            <label>Show pagination</label>
            <ha-switch id="show_pagination" ${this._config.show_pagination !== false ? 'checked' : ''}></ha-switch>
          </div>

          <div class="row">
            <label>Auto-hide pagination (ms)</label>
            <ha-textfield id="auto_hide_pagination" type="number" value="${this._config.auto_hide_pagination || 0}"></ha-textfield>
          </div>
          <div class="hint">0 = always visible</div>

          <div class="row" style="margin-top: 8px;">
            <label>Reset timeout (ms)</label>
            <ha-textfield id="reset_after_timeout" type="number" value="${this._config.enable_reset_after ? (this._config.reset_after_timeout || 30000) : 0}"></ha-textfield>
          </div>
          <div class="hint">0 = disabled. Returns to first slide after timeout</div>

          <div class="row" style="margin-top: 8px;">
            <label>Auto-reset toggle entity</label>
            <ha-entity-picker id="auto_reset_enabled_entity" allow-custom-entity></ha-entity-picker>
          </div>
          <div class="hint">Entity to enable/disable auto-reset</div>
        </div>

        <!-- Layout Section -->
        <div class="section">
          <div class="section-title">
            <ha-icon icon="mdi:ruler-square"></ha-icon>
            Layout
          </div>

          <div class="row">
            <label>Slide width</label>
            <ha-textfield id="slide_width" value="${this._config.slide_width || ''}" placeholder="100%"></ha-textfield>
          </div>

          <div class="row">
            <label>Slide height</label>
            <ha-textfield id="slide_height" value="${this._config.slide_height || ''}" placeholder="auto"></ha-textfield>
          </div>

          <div class="row">
            <label>Slide padding</label>
            <ha-textfield id="slide_padding" value="${this._config.slide_padding || ''}" placeholder="0"></ha-textfield>
          </div>

          <div class="row">
            <label>Slide gap</label>
            <ha-textfield id="slide_gap" value="${this._config.slide_gap || ''}" placeholder="0"></ha-textfield>
          </div>

          <div class="row">
            <label>Border radius</label>
            <ha-textfield id="border_radius" value="${this._config.border_radius || ''}" placeholder="0"></ha-textfield>
          </div>
        </div>
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    // Add card
    this.shadowRoot.getElementById('add-card')?.addEventListener('click', () => {
      this._addCard();
    });

    // Card actions
    this.shadowRoot.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', () => {
        const action = el.dataset.action;
        const index = parseInt(el.dataset.index);

        if (action === 'edit') {
          this._openCardEditor(index);
        } else if (action === 'delete') {
          const cards = [...(this._config.cards || [])];
          cards.splice(index, 1);
          this._config = { ...this._config, cards };
          this._fireConfigChanged();
          this._render();
        } else if (action === 'move-up' && index > 0) {
          const cards = [...(this._config.cards || [])];
          [cards[index - 1], cards[index]] = [cards[index], cards[index - 1]];
          this._config = { ...this._config, cards };
          this._fireConfigChanged();
          this._render();
        } else if (action === 'move-down' && index < (this._config.cards?.length || 0) - 1) {
          const cards = [...(this._config.cards || [])];
          [cards[index], cards[index + 1]] = [cards[index + 1], cards[index]];
          this._config = { ...this._config, cards };
          this._fireConfigChanged();
          this._render();
        }
      });
    });

    // Behavior settings
    this.shadowRoot.getElementById('infinite_loop')?.addEventListener('change', (e) => {
      this._config = { ...this._config, loop_mode: e.target.checked ? 'infinite' : 'none' };
      this._fireConfigChanged();
    });

    this.shadowRoot.getElementById('show_pagination')?.addEventListener('change', (e) => {
      this._config = { ...this._config, show_pagination: e.target.checked };
      this._fireConfigChanged();
    });

    this.shadowRoot.getElementById('auto_hide_pagination')?.addEventListener('change', (e) => {
      this._config = { ...this._config, auto_hide_pagination: parseInt(e.target.value) || 0 };
      this._fireConfigChanged();
    });

    this.shadowRoot.getElementById('reset_after_timeout')?.addEventListener('change', (e) => {
      const value = parseInt(e.target.value) || 0;
      this._config = {
        ...this._config,
        enable_reset_after: value > 0,
        reset_after_timeout: value > 0 ? value : 30000
      };
      this._fireConfigChanged();
    });

    const autoResetEntityPicker = this.shadowRoot.getElementById('auto_reset_enabled_entity');
    if (autoResetEntityPicker) {
      autoResetEntityPicker.hass = this._hass;
      autoResetEntityPicker.value = this._config.auto_reset_enabled_entity || '';
      autoResetEntityPicker.includeDomains = ['input_boolean', 'binary_sensor', 'switch'];
      autoResetEntityPicker.addEventListener('value-changed', (e) => {
        this._config = { ...this._config, auto_reset_enabled_entity: e.detail.value || null };
        this._fireConfigChanged();
      });
    }

    // Layout settings
    ['slide_width', 'slide_height', 'slide_padding', 'slide_gap', 'border_radius'].forEach(key => {
      this.shadowRoot.getElementById(key)?.addEventListener('change', (e) => {
        this._config = { ...this._config, [key]: e.target.value.trim() || null };
        this._fireConfigChanged();
      });
    });
  }

  async _openCardEditor(index) {
    const cardConfig = this._config.cards?.[index];
    const homeAssistant = document.querySelector('home-assistant');

    if (!this._hass || !homeAssistant) {
      console.error('[swipe-card-lite] Cannot find Home Assistant instance');
      return;
    }

    try {
      await customElements.whenDefined('hui-dialog-edit-card');

      const dialog = document.createElement('hui-dialog-edit-card');
      dialog.hass = this._hass;
      document.body.appendChild(dialog);

      const handleClose = () => {
        dialog.removeEventListener('dialog-closed', handleClose);
        if (dialog.parentNode === document.body) {
          document.body.removeChild(dialog);
        }
        this._render();
      };
      dialog.addEventListener('dialog-closed', handleClose);

      await dialog.showDialog({
        cardConfig: cardConfig,
        lovelaceConfig: homeAssistant.lovelace?.config || { views: [] },
        saveCardConfig: async (newConfig) => {
          if (!newConfig) return;

          const cards = [...(this._config.cards || [])];
          cards[index] = newConfig;
          this._config = { ...this._config, cards };
          this._fireConfigChanged();
          this._render();
        }
      });
    } catch (e) {
      console.error('[swipe-card-lite] Error opening card editor:', e);
    }
  }

  async _addCard() {
    const newCard = { type: 'markdown', content: 'New card' };
    const newCards = [...(this._config.cards || []), newCard];
    this._config = { ...this._config, cards: newCards };
    this._fireConfigChanged();
    this._render();
    setTimeout(() => this._openCardEditor(newCards.length - 1), 100);
  }

  _fireConfigChanged() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: this._config },
      bubbles: true,
      composed: true
    }));
  }
}

customElements.get('swipe-card-lite') || customElements.define('swipe-card-lite', SwipeCardLite);
customElements.get('swipe-card-lite-editor') || customElements.define('swipe-card-lite-editor', SwipeCardLiteEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'swipe-card-lite',
  name: 'Swipe Card Lite',
  preview: true,
  description: 'Lightweight swipe carousel card with native CSS scroll-snap and infinite loop.'
});

console.info(
  `%c SWIPE-CARD-LITE %c v${VERSION} `,
  'color: white; background: #4caf50; font-weight: 700;',
  'color: #4caf50; background: white; font-weight: 700;'
);
