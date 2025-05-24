import {
  flattenConnection,
  getPaginationVariables,
  getSeoMeta,
  UNSTABLE_Analytics as Analytics,
} from '@shopify/hydrogen';
import type {
  PriceRangeFilter,
  ProductCollectionSortKeys,
  ProductFilter,
} from '@shopify/hydrogen/storefront-api-types';
import {json, type LoaderFunctionArgs, MetaArgs} from '@shopify/remix-oxygen';
import invariant from 'tiny-invariant';
import {type Location, useLoaderData} from '@remix-run/react';

import {AppliedFilter, SortParam} from '~/components/SortFilter';
import {FILTER_URL_PREFIX} from '~/components/SortFilter';
import {routeHeaders} from '~/data/cache';
import {COLLECTION_QUERY} from '~/data/queries';
import {PAGINATION_SIZE} from '~/lib/const';
import {seoPayload} from '~/lib/seo.server';
import {parseAsCurrency} from '~/lib/utils';
import {WeaverseContent} from '~/weaverse';

export const headers = routeHeaders;
export let generateFiltersFromQuery = (
  searchParams: URLSearchParams,
): ProductFilter[] => {
  return [...searchParams.entries()].reduce((filters, [key, value]) => {
    if (key.startsWith(FILTER_URL_PREFIX)) {
      const [, filterKey, suffix, suffix2] = key.split('.');

      switch (filterKey) {
        case 'available':
          filters.push({
            available: value === 'true' || value === '1',
          });
          break;
        case 'price':
          const existingPriceFilter = filters.find(
            (filter) => 'price' in filter,
          );
          if (existingPriceFilter) {
            // @ts-expect-error
            existingPriceFilter.price[suffix] = parseFloat(value);
          } else {
            filters.push({
              price: {
                [suffix]: parseFloat(value),
              },
            });
          }
          break;
        case 'v':
          filters.push({
            variantOption: {
              name: suffix,
              value,
            },
          });
          break;
        case 'p_m':
          filters.push({
            productMetafield: {
              namespace: suffix,
              key: suffix2,
              value,
            },
          });
          break;
        case 'tag':
          filters.push({
            tag: value,
          });
          break;
        case 'vendor':
          filters.push({
            productVendor: value,
          });
          break;
        case 'type':
          filters.push({
            productType: value,
          });
          break;
        case 'v_m':
          filters.push({
            variantMetafield: {
              namespace: suffix,
              key: suffix2,
              value,
            },
          });
          break;
      }
    }
    return filters;
  }, [] as ProductFilter[]);
};

export async function loader({params, request, context}: LoaderFunctionArgs) {
  const paginationVariables = getPaginationVariables(request, {
    pageBy: PAGINATION_SIZE,
  });
  const {collectionHandle} = params;
  const locale = context.storefront.i18n;

  invariant(collectionHandle, 'Missing collectionHandle param');

  const searchParams = new URL(request.url).searchParams;

  const {sortKey, reverse} = getSortValuesFromParam(
    searchParams.get('sort') as SortParam,
  );
  // const filters = [...searchParams.entries()].reduce(
  //   (filters, [key, value]) => {
  //     if (key.startsWith(FILTER_URL_PREFIX)) {
  //       const filterKey = key.substring(FILTER_URL_PREFIX.length);
  //       filters.push({
  //         [filterKey]: JSON.parse(value),
  //       });
  //     }
  //     return filters;
  //   },
  //   [] as ProductFilter[],
  // );
  let filters = generateFiltersFromQuery(searchParams);

  console.log('filters', JSON.stringify(filters, null, 2));
  // console.log('filters1', JSON.stringify(filters1, null, 2));
  const {collection, collections} = await context.storefront.query(
    COLLECTION_QUERY,
    {
      variables: {
        ...paginationVariables,
        handle: collectionHandle,
        filters,
        sortKey,
        reverse,
        country: context.storefront.i18n.country,
        language: context.storefront.i18n.language,
      },
    },
  );

  if (!collection) {
    throw new Response('collection', {status: 404});
  }

  const seo = seoPayload.collection({collection, url: request.url});

  const allFilterValues = collection.products.filters.flatMap(
    (filter) => filter.values,
  );

  const appliedFilters = filters
    .map((filter) => {
      const foundValue = allFilterValues.find((value) => {
        const valueInput = JSON.parse(value.input as string) as ProductFilter;
        // special case for price, the user can enter something freeform (still a number, though)
        // that may not make sense for the locale/currency.
        // Basically just check if the price filter is applied at all.
        if (valueInput.price && filter.price) {
          return true;
        }
        return (
          // This comparison should be okay as long as we're not manipulating the input we
          // get from the API before using it as a URL param.
          JSON.stringify(valueInput) === JSON.stringify(filter)
        );
      });
      if (!foundValue) {
        // eslint-disable-next-line no-console
        console.error('Could not find filter value for filter', filter);
        return null;
      }

      if (foundValue.id === 'filter.v.price') {
        // Special case for price, we want to show the min and max values as the label.
        const input = JSON.parse(foundValue.input as string) as ProductFilter;
        const min = parseAsCurrency(input.price?.min ?? 0, locale);
        const max = input.price?.max
          ? parseAsCurrency(input.price.max, locale)
          : '';
        const label = min && max ? `${min} - ${max}` : 'Price';

        return {
          filter,
          label,
        };
      }
      return {
        filter,
        label: foundValue.label,
      };
    })
    .filter((filter): filter is NonNullable<typeof filter> => filter !== null);

  return json({
    collection,
    appliedFilters,
    collections: flattenConnection(collections),
    seo,
    weaverseData: await context.weaverse.loadPage({
      type: 'COLLECTION',
      handle: collectionHandle,
    }),
  });
}

export const meta = ({matches}: MetaArgs<typeof loader>) => {
  return getSeoMeta(...matches.map((match) => (match.data as any).seo));
};

export default function Collection() {
  const {collection} = useLoaderData<typeof loader>();
  return (
    <>
      <WeaverseContent />
      <Analytics.CollectionView
        data={{
          collection: {
            id: collection.id,
            handle: collection.handle,
          },
        }}
      />
    </>
  );
}

export function getSortValuesFromParam(sortParam: SortParam | null): {
  sortKey: ProductCollectionSortKeys;
  reverse: boolean;
} {
  switch (sortParam) {
    case 'price-high-low':
      return {
        sortKey: 'PRICE',
        reverse: true,
      };
    case 'price-low-high':
      return {
        sortKey: 'PRICE',
        reverse: false,
      };
    case 'best-selling':
      return {
        sortKey: 'BEST_SELLING',
        reverse: false,
      };
    case 'newest':
      return {
        sortKey: 'CREATED',
        reverse: true,
      };
    case 'featured':
      return {
        sortKey: 'MANUAL',
        reverse: false,
      };
    default:
      return {
        sortKey: 'RELEVANCE',
        reverse: false,
      };
  }
}
