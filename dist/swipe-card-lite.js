/**
 * Swipe Card Lite - Lightweight swipe carousel card for Home Assistant
 * Uses native CSS scroll-snap for smooth swiping with infinite loop support
 */

const VERSION = '2.0.3';

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
          gap: 8px;
          padding: 8px;
          position: absolute;
          bottom: 8px;
          left: 50%;
          transform: translateX(-50%);
          transition: opacity 0.3s ease-out;
          z-index: 10;
          pointer-events: none;
        }
        .pagination.hidden {
          opacity: 0;
        }
        .pagination-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: rgba(255,255,255,0.5);
          cursor: pointer;
          transition: background-color 0.15s ease, transform 0.15s ease;
          pointer-events: auto;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        .pagination-dot.active {
          background: var(--primary-color, #03a9f4);
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

    this._showPagination();
    if (this._scrollTimeout) clearTimeout(this._scrollTimeout);

    // Use longer timeout for slower devices
    this._scrollTimeout = setTimeout(() => {
      this._onScrollEnd();
    }, 150);
  }

  _onScrollEnd() {
    if (this._jumping) return;

    const scroller = this.shadowRoot?.getElementById('scroller');
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

    // Clear user scrolling flag after state sync has time to propagate
    if (this._scrollSettleTimeout) clearTimeout(this._scrollSettleTimeout);
    this._scrollSettleTimeout = setTimeout(() => {
      this._userScrolling = false;
    }, 300);
  }

  _jumpToSlide(targetDomIndex, targetRealIndex) {
    const scroller = this.shadowRoot?.getElementById('scroller');
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
      });
    });
  }

  _updatePagination() {
    const dots = this.shadowRoot?.querySelectorAll('.pagination-dot');
    if (!dots) return;
    dots.forEach((dot, i) => dot.classList.toggle('active', i === this._realIndex));
  }

  _goToRealIndex(realIndex, smooth = true) {
    const scroller = this.shadowRoot?.getElementById('scroller');
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
    if (entity.startsWith('input_number.')) {
      targetIndex = targetIndex - 1;
    }

    if (targetIndex < 0 || targetIndex >= this._cards.length) return;

    // Compare against current position, not old hass state
    // This ensures we react even if hass object references are reused
    if (targetIndex === this._realIndex) return;

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

      this._hass.callService('input_number', 'set_value', {
        entity_id: entity,
        value: targetValue
      });
    }
  }

  // ===== Pagination Auto-Hide =====

  _showPagination() {
    const pagination = this.shadowRoot?.getElementById('pagination');
    if (pagination) pagination.classList.remove('hidden');
    if (this._paginationHideTimeout) clearTimeout(this._paginationHideTimeout);
  }

  _startPaginationHideTimer() {
    if (this._config.auto_hide_pagination <= 0) return;
    if (this._paginationHideTimeout) clearTimeout(this._paginationHideTimeout);

    this._paginationHideTimeout = setTimeout(() => {
      const pagination = this.shadowRoot?.getElementById('pagination');
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
    this._editingCardIndex = null;
  }

  setConfig(config) {
    this._config = {
      ...config,
      cards: config.cards || [],
      show_pagination: config.show_pagination !== false,
      loop_mode: config.loop_mode || 'none',
      slide_width: config.slide_width || '',
      slide_height: config.slide_height || '',
      slide_padding: config.slide_padding || '',
      border_radius: config.border_radius || '',
      show_version: config.show_version || false,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  _render() {
    const showPagination = this._config.show_pagination !== false;
    const infiniteLoop = this._config.loop_mode === 'infinite' || this._config.loop_mode === 'loopback';
    const cards = this._config.cards || [];

    this.shadowRoot.innerHTML = `
      <style>
        .editor { padding: 16px; }
        .section { margin-bottom: 16px; }
        .section-title { font-weight: 500; margin-bottom: 8px; color: var(--primary-text-color); }
        .option { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--divider-color); }
        .option:last-child { border-bottom: none; }
        .hint { font-size: 11px; color: var(--secondary-text-color); margin: -4px 0 8px 0; padding: 0; }
        ha-textfield { width: 120px; }

        .cards-section { margin-top: 16px; }
        .card-item {
          background: var(--card-background-color, var(--ha-card-background));
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          margin-bottom: 8px;
          overflow: hidden;
        }
        .card-header {
          display: flex;
          align-items: center;
          padding: 12px;
          cursor: pointer;
          user-select: none;
        }
        .card-header:hover {
          background: var(--secondary-background-color);
        }
        .card-index {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: var(--primary-color);
          color: var(--text-primary-color, white);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 500;
          margin-right: 12px;
          flex-shrink: 0;
        }
        .card-type {
          flex: 1;
          font-size: 14px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .card-actions {
          display: flex;
          gap: 4px;
        }
        .card-actions ha-icon-button {
          --mdc-icon-button-size: 36px;
          --mdc-icon-size: 20px;
        }
        .add-card {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 12px;
          border: 2px dashed var(--divider-color);
          border-radius: 8px;
          cursor: pointer;
          color: var(--secondary-text-color);
          transition: all 0.2s;
        }
        .add-card:hover {
          border-color: var(--primary-color);
          color: var(--primary-color);
        }
        .add-card ha-icon {
          margin-right: 8px;
        }
      </style>
      <div class="editor">
        <div class="section">
          <div class="section-title">Settings</div>

          <div class="option">
            <span>Show Pagination</span>
            <ha-switch
              id="show-pagination-switch"
              data-key="show_pagination"
            ></ha-switch>
          </div>

          <div class="option">
            <span>Infinite Loop</span>
            <ha-switch
              id="infinite-loop-switch"
            ></ha-switch>
          </div>

          <div class="option">
            <span>Auto-hide Pagination (ms)</span>
            <ha-textfield
              id="auto-hide-field"
              type="number"
              min="0"
              data-key="auto_hide_pagination"
            ></ha-textfield>
          </div>

          <div class="option">
            <span>Reset Timeout (ms)</span>
            <ha-textfield
              id="reset-timeout-field"
              type="number"
              min="0"
            ></ha-textfield>
          </div>

          <div class="option">
            <span>Auto-Reset Toggle</span>
            <ha-textfield
              id="auto-reset-entity-field"
              data-key="auto_reset_enabled_entity"
              placeholder="input_boolean.xxx"
            ></ha-textfield>
          </div>
          <div class="hint">Boolean entity to pause auto-reset (off = paused)</div>

          <div class="option">
            <span>Slide Width (CSS)</span>
            <ha-textfield
              id="slide-width-field"
              data-key="slide_width"
              placeholder="100%"
            ></ha-textfield>
          </div>

          <div class="option">
            <span>Slide Height (CSS)</span>
            <ha-textfield
              id="slide-height-field"
              data-key="slide_height"
              placeholder="auto"
            ></ha-textfield>
          </div>

          <div class="option">
            <span>Slide Padding</span>
            <ha-textfield
              id="slide-padding-field"
              data-key="slide_padding"
              placeholder="0"
            ></ha-textfield>
          </div>
          <div class="hint">Inner spacing inside each slide (always visible)</div>

          <div class="option">
            <span>Slide Gap</span>
            <ha-textfield
              id="slide-gap-field"
              data-key="slide_gap"
              placeholder="0"
            ></ha-textfield>
          </div>
          <div class="hint">Space between slides (visible only while swiping)</div>

          <div class="option">
            <span>Border Radius</span>
            <ha-textfield
              id="border-radius-field"
              data-key="border_radius"
              placeholder="0"
            ></ha-textfield>
          </div>

          <div class="option">
            <span>Show Version</span>
            <ha-switch
              id="show-version-switch"
              data-key="show_version"
            ></ha-switch>
          </div>
        </div>

        <div class="cards-section">
          <div class="section-title">Cards (${cards.length})</div>
          <div id="cards-list">
            ${cards.map((card, index) => this._renderCardItem(card, index)).join('')}
          </div>
          <div class="add-card" id="add-card">
            <ha-icon icon="mdi:plus"></ha-icon>
            <span>Add Card</span>
          </div>
        </div>
      </div>
    `;

    // Set initial values for settings controls
    const showPaginationSwitch = this.shadowRoot.getElementById('show-pagination-switch');
    const infiniteLoopSwitch = this.shadowRoot.getElementById('infinite-loop-switch');
    const autoHideField = this.shadowRoot.getElementById('auto-hide-field');
    const resetTimeoutField = this.shadowRoot.getElementById('reset-timeout-field');

    if (showPaginationSwitch) {
      showPaginationSwitch.checked = showPagination;
      showPaginationSwitch.addEventListener('change', (e) => this._settingChanged(e));
    }

    if (infiniteLoopSwitch) {
      infiniteLoopSwitch.checked = infiniteLoop;
      infiniteLoopSwitch.addEventListener('change', (e) => this._loopChanged(e));
    }

    if (autoHideField) {
      autoHideField.value = this._config.auto_hide_pagination || 0;
      autoHideField.addEventListener('change', (e) => this._settingChanged(e));
    }

    if (resetTimeoutField) {
      resetTimeoutField.value = this._config.enable_reset_after ? (this._config.reset_after_timeout || 30000) : 0;
      resetTimeoutField.addEventListener('change', (e) => this._resetTimeoutChanged(e));
    }

    const autoResetEntityField = this.shadowRoot.getElementById('auto-reset-entity-field');
    if (autoResetEntityField) {
      autoResetEntityField.value = this._config.auto_reset_enabled_entity || '';
      autoResetEntityField.addEventListener('change', (e) => this._settingChanged(e));
    }

    const slideWidthField = this.shadowRoot.getElementById('slide-width-field');
    if (slideWidthField) {
      slideWidthField.value = this._config.slide_width || '';
      slideWidthField.addEventListener('change', (e) => this._settingChanged(e));
    }

    const slideHeightField = this.shadowRoot.getElementById('slide-height-field');
    if (slideHeightField) {
      slideHeightField.value = this._config.slide_height || '';
      slideHeightField.addEventListener('change', (e) => this._settingChanged(e));
    }

    const slidePaddingField = this.shadowRoot.getElementById('slide-padding-field');
    if (slidePaddingField) {
      slidePaddingField.value = this._config.slide_padding || '';
      slidePaddingField.addEventListener('change', (e) => this._settingChanged(e));
    }

    const slideGapField = this.shadowRoot.getElementById('slide-gap-field');
    if (slideGapField) {
      slideGapField.value = this._config.slide_gap || '';
      slideGapField.addEventListener('change', (e) => this._settingChanged(e));
    }

    const borderRadiusField = this.shadowRoot.getElementById('border-radius-field');
    if (borderRadiusField) {
      borderRadiusField.value = this._config.border_radius || '';
      borderRadiusField.addEventListener('change', (e) => this._settingChanged(e));
    }

    const showVersionSwitch = this.shadowRoot.getElementById('show-version-switch');
    if (showVersionSwitch) {
      showVersionSwitch.checked = this._config.show_version || false;
      showVersionSwitch.addEventListener('change', (e) => this._settingChanged(e));
    }

    // Attach event listeners
    this.shadowRoot.getElementById('add-card')?.addEventListener('click', () => this._addCard());

    this.shadowRoot.querySelectorAll('.card-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (!e.target.closest('ha-icon-button')) {
          const index = parseInt(header.dataset.index);
          this._toggleCardEditor(index);
        }
      });
    });

    this.shadowRoot.querySelectorAll('.move-up').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._moveCard(parseInt(btn.dataset.index), -1);
      });
    });

    this.shadowRoot.querySelectorAll('.move-down').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._moveCard(parseInt(btn.dataset.index), 1);
      });
    });

    this.shadowRoot.querySelectorAll('.delete-card').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._deleteCard(parseInt(btn.dataset.index));
      });
    });
  }

  _renderCardItem(card, index) {
    const cardType = card.type || 'unknown';
    const cards = this._config.cards || [];

    return `
      <div class="card-item">
        <div class="card-header" data-index="${index}">
          <div class="card-index">${index + 1}</div>
          <div class="card-type">${cardType}</div>
          <div class="card-actions">
            <ha-icon-button class="move-up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>
              <ha-icon icon="mdi:arrow-up"></ha-icon>
            </ha-icon-button>
            <ha-icon-button class="move-down" data-index="${index}" ${index === cards.length - 1 ? 'disabled' : ''}>
              <ha-icon icon="mdi:arrow-down"></ha-icon>
            </ha-icon-button>
            <ha-icon-button class="delete-card" data-index="${index}">
              <ha-icon icon="mdi:delete"></ha-icon>
            </ha-icon-button>
          </div>
        </div>
      </div>
    `;
  }

  async _openCardEditor(index) {
    const cardConfig = this._config.cards[index];
    const hass = this._hass;
    const homeAssistant = document.querySelector('home-assistant');

    if (!hass || !homeAssistant) {
      console.error('[swipe-card-lite] Cannot find Home Assistant instance');
      return;
    }

    try {
      // Wait for the dialog element to be defined
      await customElements.whenDefined('hui-dialog-edit-card');

      // Create the dialog element
      const dialog = document.createElement('hui-dialog-edit-card');
      dialog.hass = hass;
      document.body.appendChild(dialog);

      // Handle dialog close
      const handleClose = () => {
        dialog.removeEventListener('dialog-closed', handleClose);
        if (dialog.parentNode === document.body) {
          document.body.removeChild(dialog);
        }
        this._render(); // Re-render to update card type display
      };
      dialog.addEventListener('dialog-closed', handleClose);

      // Open the dialog with card config
      await dialog.showDialog({
        cardConfig: cardConfig,
        lovelaceConfig: homeAssistant.lovelace?.config || { views: [] },
        saveCardConfig: async (newConfig) => {
          if (!newConfig) return;

          const newCards = [...this._config.cards];
          newCards[index] = newConfig;
          this._config = { ...this._config, cards: newCards };
          this._fireConfigChanged();
          this._render();
        }
      });
    } catch (e) {
      console.error('[swipe-card-lite] Error opening card editor:', e);
    }
  }

  _toggleCardEditor(index) {
    this._openCardEditor(index);
  }

  async _addCard() {
    const newCard = { type: 'markdown', content: 'New card' };
    const newCards = [...(this._config.cards || []), newCard];
    this._config = { ...this._config, cards: newCards };
    this._fireConfigChanged();
    this._render();
    // Open the editor for the new card
    setTimeout(() => this._openCardEditor(newCards.length - 1), 100);
  }

  _moveCard(index, direction) {
    const newIndex = index + direction;
    const cards = [...this._config.cards];
    if (newIndex < 0 || newIndex >= cards.length) return;

    [cards[index], cards[newIndex]] = [cards[newIndex], cards[index]];

    this._config = { ...this._config, cards };
    this._fireConfigChanged();
    this._render();
  }

  _deleteCard(index) {
    const cards = [...this._config.cards];
    cards.splice(index, 1);

    this._config = { ...this._config, cards };
    this._fireConfigChanged();
    this._render();
  }

  _settingChanged(e) {
    const key = e.target.dataset.key;
    let value = e.target.value;

    if (e.target.tagName === 'HA-SWITCH') {
      value = e.target.checked;
    } else if (key === 'auto_hide_pagination') {
      value = parseInt(value, 10) || 0;
    } else if (key === 'slide_width' || key === 'slide_height' || key === 'slide_padding' || key === 'border_radius') {
      value = value.trim() || null;
    }

    this._config = { ...this._config, [key]: value };
    this._fireConfigChanged();
  }

  _loopChanged(e) {
    this._config = {
      ...this._config,
      loop_mode: e.target.checked ? 'infinite' : 'none'
    };
    this._fireConfigChanged();
  }

  _resetTimeoutChanged(e) {
    const value = parseInt(e.target.value, 10) || 0;
    this._config = {
      ...this._config,
      enable_reset_after: value > 0,
      reset_after_timeout: value > 0 ? value : 30000
    };
    this._fireConfigChanged();
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
