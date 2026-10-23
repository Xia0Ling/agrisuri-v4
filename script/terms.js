/* ============================================================================
 * Terms of use.
 *
 * The app names the most likely disease from one photo. That is a guess, and
 * the terms are the record that the farmer was told so — before acting on it,
 * not buried in a footer.
 *
 * Self-contained on purpose: auth.html does not load util.js, and the same
 * notice has to work there and inside the app.
 * ========================================================================== */

const TERMS_VERSION = '2026-10';

const Terms = (() => {
  const COPY = {
    en: {
      title: 'Before you rely on this',
      lead: 'Short, and it matters. Please read it.',
      accept: 'I understand and agree',
      close: 'Close',
      clauses: [
        ['A guess, not a diagnosis.',
          'The AI looks at one photo and names the most likely disease. It can be wrong, and it can be confidently wrong.'],
        ['Do not rely on it alone.',
          'Look at the plant yourself. Check more than one leaf. If the answer matters, ask someone who can walk the field with you.'],
        ['You agree to consult an expert.',
          'Before you spend on chemicals, destroy a crop, or change anything that affects your harvest or income, confirm it with your municipal agriculturist or a DA technician.'],
        ['It does not replace an expert.',
          'AgriSuri is a first look. It is not a substitute for an agricultural professional, a laboratory test, or your own judgement.'],
        ['You stay responsible.',
          'You know your field, your soil and your season. The app does not. Whatever you decide after using it is your decision, and it is yours to answer for.'],
      ],
    },
    fil: {
      title: 'Bago ka umasa dito',
      lead: 'Maikli lang, at mahalaga. Pakibasa.',
      accept: 'Naiintindihan ko at pumapayag ako',
      close: 'Isara',
      clauses: [
        ['Hula, hindi diagnosis.',
          'Tumingin ang AI sa isang litrato at pinipili ang pinakamalamang na sakit. Puwedeng mali ito, at puwedeng kumpiyansa pa itong magkamali.'],
        ['Huwag umasa dito nang nag-iisa.',
          'Tingnan mo mismo ang halaman. Suriin ang higit sa isang dahon. Kung mahalaga ang sagot, magtanong sa taong kayang samahan kang pumunta sa bukid.'],
        ['Pumapayag kang kumonsulta sa eksperto.',
          'Bago gumastos sa gamot, sirain ang pananim, o baguhin ang anumang makakaapekto sa ani o kita mo, kumpirmahin ito sa municipal agriculturist o DA technician.'],
        ['Hindi nito pinapalitan ang eksperto.',
          'Unang tingin lang ang AgriSuri. Hindi ito kapalit ng propesyonal sa agrikultura, ng pagsusuri sa laboratoryo, o ng sarili mong paghatol.'],
        ['Ikaw pa rin ang may pananagutan.',
          'Mas kilala mo ang bukid, lupa at panahon mo. Hindi ito alam ng app. Desisyon mo ang anumang gagawin mo pagkatapos gamitin ito, at ikaw ang mananagot dito.'],
      ],
    },
  };

  // util.js is not loaded on auth.html, so this cannot use its esc().
  const escapeText = (value) =>
    String(value).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));

  const lang = () =>
    (document.documentElement.lang || 'en').toLowerCase().startsWith('fil') ? 'fil' : 'en';

  /**
   * blocking: true  -> only "I agree" dismisses it. Used as a gate.
   * blocking: false -> a Close button appears. Used when reading from sign-up.
   */
  function show(options) {
    const blocking = !options || options.blocking !== false;
    const copy = COPY[lang()];

    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'terms';
      el.id = 'terms-modal';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.innerHTML = `
        <div class="terms__card">
          <h2 class="terms__title">${escapeText(copy.title)}</h2>
          <p class="terms__lead">${escapeText(copy.lead)}</p>
          <ol class="terms__list">
            ${copy.clauses
              .map(([head, body]) => `<li><b>${escapeText(head)}</b> ${escapeText(body)}</li>`)
              .join('')}
          </ol>
          <div class="terms__foot">
            ${blocking ? '' : `<button class="btn btn--ghost" type="button" data-terms-close>${escapeText(copy.close)}</button>`}
            <button class="btn btn--primary" type="button" data-terms-accept>${escapeText(copy.accept)}</button>
            <span class="terms__version">Version ${escapeText(TERMS_VERSION)}</span>
          </div>
        </div>`;

      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add('is-open'));

      const done = (accepted) => {
        el.classList.remove('is-open');
        setTimeout(() => el.remove(), 200);
        resolve(accepted);
      };

      el.querySelector('[data-terms-accept]').addEventListener('click', () => done(true));
      const close = el.querySelector('[data-terms-close]');
      if (close) close.addEventListener('click', () => done(false));
    });
  }

  return { show, VERSION: TERMS_VERSION, copy: () => COPY[lang()] };
})();
